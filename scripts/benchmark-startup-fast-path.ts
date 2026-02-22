#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STARTUP_TIMING_PREFIX } from "../src/startup-timing.js";

type StartupProfile = "interactive" | "headless";
type ProfileSelection = StartupProfile | "both";
type StartupMetric = "create-session" | "bind-extensions" | "first-token";

interface BenchmarkArgs {
	readonly json: boolean;
	readonly profile: ProfileSelection;
	readonly runs: number;
	readonly warmup: number;
}

interface StartupTimingSample {
	readonly metric: StartupMetric;
	readonly milliseconds: number;
	readonly phaseMilliseconds?: number;
	readonly profile: StartupProfile;
}

interface MetricStats {
	readonly averageMs: number;
	readonly medianMs: number;
	readonly samples: number;
}

interface ProfileBenchResult {
	readonly metrics: Partial<Record<StartupMetric, MetricStats>>;
	readonly missingMetrics: StartupMetric[];
	readonly profile: StartupProfile;
}

const RUNNER_PATH = resolve(import.meta.dirname, "./startup-bench-runner.ts");
const ALL_METRICS: readonly StartupMetric[] = [
	"create-session",
	"bind-extensions",
	"first-token",
] as const;

/**
 * Print usage information.
 *
 * @returns Nothing
 */
function printHelp(): void {
	console.log(`Usage: bun scripts/benchmark-startup-fast-path.ts [options]

Benchmarks startup fast-path timings by running instrumented sessions and
comparing interactive vs headless startup profiles.

Options:
  --runs <n>      Number of measured runs per profile (default: 10)
  --warmup <n>    Warmup runs per profile, discarded (default: 2)
  --profile <p>   interactive | headless | both (default: both)
  --json          Output machine-readable JSON
  --help          Show this help

Examples:
  bun scripts/benchmark-startup-fast-path.ts
  bun scripts/benchmark-startup-fast-path.ts --runs 20 --warmup 5
  bun scripts/benchmark-startup-fast-path.ts --profile headless --json`);
}

/**
 * Parse CLI flags for the benchmark script.
 *
 * @param argv - Raw CLI args (without node/bun executable)
 * @returns Parsed benchmark arguments
 * @throws {Error} When an argument is invalid
 */
function parseArgs(argv: readonly string[]): BenchmarkArgs {
	let runs = 10;
	let warmup = 2;
	let profile: ProfileSelection = "both";
	let json = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help") {
			printHelp();
			process.exit(0);
		}

		if (arg === "--json") {
			json = true;
			continue;
		}

		if (arg === "--runs") {
			const value = argv[++i];
			runs = Number.parseInt(value ?? "", 10);
			continue;
		}

		if (arg === "--warmup") {
			const value = argv[++i];
			warmup = Number.parseInt(value ?? "", 10);
			continue;
		}

		if (arg === "--profile") {
			const value = argv[++i];
			if (value === "interactive" || value === "headless" || value === "both") {
				profile = value;
				continue;
			}
			throw new Error(`Invalid --profile value: ${value ?? "(missing)"}`);
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!Number.isFinite(runs) || runs <= 0) {
		throw new Error("--runs must be a positive integer");
	}
	if (!Number.isFinite(warmup) || warmup < 0) {
		throw new Error("--warmup must be a non-negative integer");
	}

	return {
		json,
		profile,
		runs,
		warmup,
	};
}

/**
 * Parse timing samples from stderr output.
 *
 * @param stderr - Captured stderr text from a runner execution
 * @returns Parsed startup timing samples
 */
function parseTimingSamples(stderr: string): StartupTimingSample[] {
	const samples: StartupTimingSample[] = [];
	const lines = stderr.split(/\r?\n/).filter(Boolean);

	for (const line of lines) {
		if (!line.startsWith(`${STARTUP_TIMING_PREFIX} `)) {
			continue;
		}

		const payloadText = line.slice(STARTUP_TIMING_PREFIX.length + 1);
		try {
			const payload = JSON.parse(payloadText) as {
				metric?: string;
				milliseconds?: number;
				phaseMilliseconds?: number;
				profile?: string;
			};

			if (
				typeof payload.metric !== "string" ||
				typeof payload.milliseconds !== "number" ||
				(payload.profile !== "interactive" && payload.profile !== "headless")
			) {
				continue;
			}

			if (!ALL_METRICS.includes(payload.metric as StartupMetric)) {
				continue;
			}

			samples.push({
				metric: payload.metric as StartupMetric,
				milliseconds: payload.milliseconds,
				phaseMilliseconds:
					typeof payload.phaseMilliseconds === "number" ? payload.phaseMilliseconds : undefined,
				profile: payload.profile,
			});
		} catch {
			// Ignore malformed lines
		}
	}

	return samples;
}

/**
 * Compute average and median for a metric sample set.
 *
 * @param values - Millisecond samples
 * @returns Aggregate metric statistics
 */
function computeStats(values: readonly number[]): MetricStats {
	const sorted = [...values].sort((a, b) => a - b);
	const sum = sorted.reduce((acc, value) => acc + value, 0);
	const middle = Math.floor(sorted.length / 2);
	const medianMs =
		sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];

	return {
		averageMs: sum / sorted.length,
		medianMs,
		samples: sorted.length,
	};
}

/**
 * Run one instrumented benchmark scenario via startup-bench-runner.
 *
 * @param profile - Startup profile to benchmark
 * @param tallowHome - Isolated TALLOW_HOME used for this benchmark profile
 * @returns Parsed timing samples from the run
 */
async function runSingleScenario(
	profile: StartupProfile,
	tallowHome: string
): Promise<StartupTimingSample[]> {
	return new Promise((resolveResult, rejectResult) => {
		const child = spawn("bun", [RUNNER_PATH], {
			env: {
				...process.env,
				TALLOW_BENCH_PROFILE: profile,
				TALLOW_HOME: tallowHome,
				TALLOW_STARTUP_TIMING: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stderr = "";
		let stdout = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});

		child.on("close", (code) => {
			if (code !== 0) {
				rejectResult(
					new Error(
						`Runner failed for profile=${profile} (exit ${code ?? "null"})\n` +
							`stdout:\n${stdout}\n` +
							`stderr:\n${stderr}`
					)
				);
				return;
			}

			resolveResult(parseTimingSamples(stderr));
		});
	});
}

/**
 * Run warmup + measured runs for one profile.
 *
 * @param profile - Startup profile under test
 * @param runs - Number of measured runs
 * @param warmup - Number of discarded warmup runs
 * @returns Profile benchmark result with per-metric aggregates
 */
async function benchmarkProfile(
	profile: StartupProfile,
	runs: number,
	warmup: number
): Promise<ProfileBenchResult> {
	const tallowHome = mkdtempSync(join(tmpdir(), `tallow-startup-bench-${profile}-`));
	const samplesByMetric = new Map<StartupMetric, number[]>();
	for (const metric of ALL_METRICS) {
		samplesByMetric.set(metric, []);
	}

	try {
		for (let index = 0; index < warmup + runs; index++) {
			const samples = await runSingleScenario(profile, tallowHome);
			if (index < warmup) {
				continue;
			}

			for (const sample of samples) {
				samplesByMetric.get(sample.metric)?.push(sample.milliseconds);
			}
		}
	} finally {
		rmSync(tallowHome, { force: true, recursive: true });
	}

	const metrics: Partial<Record<StartupMetric, MetricStats>> = {};
	const missingMetrics: StartupMetric[] = [];

	for (const metric of ALL_METRICS) {
		const values = samplesByMetric.get(metric) ?? [];
		if (values.length === 0) {
			missingMetrics.push(metric);
			continue;
		}
		metrics[metric] = computeStats(values);
	}

	return {
		metrics,
		missingMetrics,
		profile,
	};
}

/**
 * Render a human-readable benchmark report.
 *
 * @param args - Benchmark configuration
 * @param results - Per-profile benchmark results
 * @returns Report text
 */
function renderTextReport(args: BenchmarkArgs, results: readonly ProfileBenchResult[]): string {
	const lines: string[] = [];
	lines.push("Startup fast-path benchmark");
	lines.push(`runs=${args.runs} warmup=${args.warmup} profile=${args.profile}`);
	lines.push("");

	for (const result of results) {
		lines.push(`${result.profile}:`);
		for (const metric of ALL_METRICS) {
			const stats = result.metrics[metric];
			if (!stats) {
				lines.push(`  - ${metric}: missing`);
				continue;
			}
			lines.push(
				`  - ${metric}: avg=${stats.averageMs.toFixed(2)}ms median=${stats.medianMs.toFixed(2)}ms n=${stats.samples}`
			);
		}
		if (result.missingMetrics.length > 0) {
			lines.push(`  missing metrics: ${result.missingMetrics.join(", ")}`);
		}
		lines.push("");
	}

	const interactive = results.find((result) => result.profile === "interactive");
	const headless = results.find((result) => result.profile === "headless");
	if (!interactive || !headless) {
		return lines.join("\n");
	}

	lines.push("headless vs interactive delta (avg):");
	for (const metric of ALL_METRICS) {
		const interactiveStats = interactive.metrics[metric];
		const headlessStats = headless.metrics[metric];
		if (!interactiveStats || !headlessStats) {
			lines.push(`  - ${metric}: unavailable`);
			continue;
		}

		const deltaMs = interactiveStats.averageMs - headlessStats.averageMs;
		const deltaPct =
			interactiveStats.averageMs === 0 ? 0 : (deltaMs / interactiveStats.averageMs) * 100;
		const direction = deltaMs >= 0 ? "faster" : "slower";
		lines.push(
			`  - ${metric}: ${Math.abs(deltaMs).toFixed(2)}ms (${Math.abs(deltaPct).toFixed(2)}%) ${direction}`
		);
	}

	return lines.join("\n");
}

/**
 * Execute the benchmark workflow.
 *
 * @returns Nothing
 */
async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const profiles: StartupProfile[] =
		args.profile === "both" ? ["interactive", "headless"] : [args.profile];

	const results: ProfileBenchResult[] = [];
	for (const profile of profiles) {
		results.push(await benchmarkProfile(profile, args.runs, args.warmup));
	}

	if (args.json) {
		console.log(
			JSON.stringify(
				{
					config: args,
					results,
				},
				null,
				2
			)
		);
		return;
	}

	console.log(renderTextReport(args, results));
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`benchmark-startup-fast-path failed: ${message}\n`);
	process.exit(1);
});
