#!/usr/bin/env bun

import { createTallowSession } from "../src/sdk.js";
import { createMockModel, createScriptedStreamFn } from "../test-utils/mock-model.js";

/**
 * Parse startup profile from TALLOW_BENCH_PROFILE env var.
 *
 * @returns Startup profile for this benchmark run
 * @throws {Error} When TALLOW_BENCH_PROFILE has an unsupported value
 */
function resolveBenchmarkProfile(): "interactive" | "headless" {
	const raw = process.env.TALLOW_BENCH_PROFILE;
	if (raw === "interactive" || raw === "headless") {
		return raw;
	}

	throw new Error(
		'TALLOW_BENCH_PROFILE must be set to "interactive" or "headless" for startup bench runs'
	);
}

/**
 * Execute one benchmark scenario and emit timing lines via SDK instrumentation.
 *
 * @returns Nothing
 */
async function run(): Promise<void> {
	const startupProfile = resolveBenchmarkProfile();
	const tallow = await createTallowSession({
		apiKey: "mock-api-key",
		cwd: process.cwd(),
		model: createMockModel(),
		noBundledSkills: true,
		provider: "mock",
		session: { type: "memory" },
		startupProfile,
	});

	tallow.session.agent.streamFn = createScriptedStreamFn([{ text: "bench" }]);

	try {
		await tallow.session.bindExtensions({});
		await tallow.session.prompt("ping");
	} finally {
		const disposableSession = tallow.session as { dispose?: () => void };
		disposableSession.dispose?.();
	}
}

run()
	.then(() => {
		process.exit(0);
	})
	.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`[startup-bench-runner] ${message}\n`);
		process.exit(1);
	});
