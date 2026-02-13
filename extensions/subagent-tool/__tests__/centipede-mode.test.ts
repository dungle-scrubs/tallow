/**
 * Tests for centipede mode (formerly "chain") in the subagent tool.
 *
 * Verifies:
 * - Mode detection: `centipede` param → centipede mode
 * - Mode detection: old `chain` param → not recognized (mode count 0)
 * - `{previous}` placeholder substitution between steps
 * - CentipedeItem schema shape
 */
import { describe, expect, it } from "bun:test";

// ── Helpers (mirrored from subagent-tool/index.ts) ───────────────────────────

/**
 * Coerce a value that may be an array or a JSON string of an array.
 * @param value - Raw parameter value
 * @returns Coerced array, or undefined
 */
function coerceArray<T>(value: T[] | string | undefined | null): T[] | undefined {
	if (value == null) return undefined;
	if (Array.isArray(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed as T[];
		} catch {
			/* not valid JSON */
		}
	}
	return undefined;
}

interface StepItem {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
}

/**
 * Detect which mode the params describe. Mirrors the logic in execute().
 * @param params - Raw tool params
 * @returns Detected mode and count of active modes
 */
function detectMode(params: {
	agent?: string;
	task?: string;
	tasks?: StepItem[];
	centipede?: StepItem[];
	/** Old param name — should be ignored */
	chain?: StepItem[];
}): { mode: "single" | "parallel" | "centipede" | "invalid"; modeCount: number } {
	const tasks = coerceArray(params.tasks);
	const centipede = coerceArray(params.centipede);

	const hasCentipede = (centipede?.length ?? 0) > 0;
	const hasTasks = (tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasCentipede) + Number(hasTasks) + Number(hasSingle);

	if (modeCount !== 1) return { mode: "invalid", modeCount };
	if (hasCentipede) return { mode: "centipede", modeCount: 1 };
	if (hasTasks) return { mode: "parallel", modeCount: 1 };
	return { mode: "single", modeCount: 1 };
}

// ═════════════════════════════════════════════════════════════════
// Mode Detection
// ═════════════════════════════════════════════════════════════════

describe("centipede mode detection", () => {
	it("recognizes centipede param as centipede mode", () => {
		const result = detectMode({
			centipede: [
				{ agent: "scout", task: "explore" },
				{ agent: "worker", task: "implement {previous}" },
			],
		});
		expect(result.mode).toBe("centipede");
		expect(result.modeCount).toBe(1);
	});

	it("old chain param is not recognized — yields mode count 0", () => {
		// After rename, `chain` is not a valid param. The execute function reads
		// `params.centipede`, so `chain` is simply ignored.
		const result = detectMode({
			chain: [
				{ agent: "scout", task: "explore" },
				{ agent: "worker", task: "implement {previous}" },
			],
		});
		expect(result.mode).toBe("invalid");
		expect(result.modeCount).toBe(0);
	});

	it("single mode: agent + task", () => {
		const result = detectMode({ agent: "worker", task: "do stuff" });
		expect(result.mode).toBe("single");
	});

	it("parallel mode: tasks array", () => {
		const result = detectMode({
			tasks: [
				{ agent: "a", task: "1" },
				{ agent: "b", task: "2" },
			],
		});
		expect(result.mode).toBe("parallel");
	});

	it("rejects multiple modes simultaneously", () => {
		const result = detectMode({
			agent: "worker",
			task: "do stuff",
			centipede: [{ agent: "scout", task: "explore" }],
		});
		expect(result.mode).toBe("invalid");
		expect(result.modeCount).toBe(2);
	});

	it("rejects empty params", () => {
		const result = detectMode({});
		expect(result.mode).toBe("invalid");
		expect(result.modeCount).toBe(0);
	});

	it("ignores empty centipede array", () => {
		const result = detectMode({ centipede: [] });
		expect(result.mode).toBe("invalid");
		expect(result.modeCount).toBe(0);
	});

	it("coerces centipede from JSON string", () => {
		const steps = [
			{ agent: "scout", task: "explore" },
			{ agent: "worker", task: "build {previous}" },
		];
		const result = detectMode({
			centipede: JSON.stringify(steps) as unknown as StepItem[],
		});
		expect(result.mode).toBe("centipede");
		expect(result.modeCount).toBe(1);
	});
});

// ═════════════════════════════════════════════════════════════════
// {previous} Placeholder Substitution
// ═════════════════════════════════════════════════════════════════

describe("{previous} placeholder substitution", () => {
	it("replaces {previous} with prior step output", () => {
		const task = "Review the following code:\n{previous}\n\nCheck for bugs.";
		const previousOutput = "function add(a, b) { return a + b; }";
		const result = task.replace(/\{previous\}/g, previousOutput);

		expect(result).toBe(
			"Review the following code:\nfunction add(a, b) { return a + b; }\n\nCheck for bugs."
		);
	});

	it("replaces multiple {previous} occurrences", () => {
		const task = "Compare {previous} with {previous}";
		const previousOutput = "v2";
		const result = task.replace(/\{previous\}/g, previousOutput);

		expect(result).toBe("Compare v2 with v2");
	});

	it("leaves task unchanged when no {previous} placeholder", () => {
		const task = "Just do the thing";
		const result = task.replace(/\{previous\}/g, "ignored output");

		expect(result).toBe("Just do the thing");
	});

	it("handles empty previous output", () => {
		const task = "Build on: {previous}";
		const result = task.replace(/\{previous\}/g, "");

		expect(result).toBe("Build on: ");
	});

	it("handles multiline previous output", () => {
		const task = "Improve this:\n{previous}";
		const previousOutput = "line 1\nline 2\nline 3";
		const result = task.replace(/\{previous\}/g, previousOutput);

		expect(result).toBe("Improve this:\nline 1\nline 2\nline 3");
	});
});

// ═════════════════════════════════════════════════════════════════
// Centipede Step Shape
// ═════════════════════════════════════════════════════════════════

describe("centipede step shape", () => {
	it("accepts minimal step: agent + task", () => {
		const step: StepItem = { agent: "worker", task: "do work" };
		expect(step.agent).toBe("worker");
		expect(step.task).toBe("do work");
		expect(step.cwd).toBeUndefined();
		expect(step.model).toBeUndefined();
	});

	it("accepts step with all optional fields", () => {
		const step: StepItem = {
			agent: "worker",
			task: "do work",
			cwd: "/tmp/project",
			model: "claude-sonnet-4-20250514",
		};
		expect(step.cwd).toBe("/tmp/project");
		expect(step.model).toBe("claude-sonnet-4-20250514");
	});

	it("builds centipede steps array for progress display", () => {
		const centipede: StepItem[] = [
			{ agent: "scout", task: "explore the codebase" },
			{ agent: "planner", task: "create plan from {previous}" },
			{ agent: "worker", task: "implement {previous}" },
		];
		const centipedeSteps = centipede.map((s) => ({ agent: s.agent, task: s.task }));

		expect(centipedeSteps).toHaveLength(3);
		expect(centipedeSteps[0].agent).toBe("scout");
		expect(centipedeSteps[2].task).toContain("{previous}");
	});
});
