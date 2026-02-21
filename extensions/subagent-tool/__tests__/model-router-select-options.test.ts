import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createMockScope } from "../../../test-utils/mock-scope.js";

const selectModelsMock = mock(
	(_classification: unknown, _costPreference: unknown, _options: unknown) => [
		{
			displayName: "anthropic/claude-sonnet-4-5-20250514",
			id: "claude-sonnet-4-5-20250514",
			provider: "anthropic",
		},
	]
);

const mockScope = createMockScope(import.meta.url);
mockScope.module("@dungle-scrubs/synapse", () => ({
	listAvailableModels: () => ["anthropic/claude-sonnet-4-5-20250514"],
	parseModelMatrixOverrides: () => undefined,
	resolveModelCandidates: () => [],
	resolveModelFuzzy: (query: string) => ({
		displayName: `anthropic/${query}`,
		id: query,
		provider: "anthropic",
	}),
	selectModels: selectModelsMock,
}));

mockScope.module("../task-classifier.js", () => ({
	classifyTask: async () => ({ complexity: 3, reasoning: "mock", type: "code" }),
	findCheapestModel: () => undefined,
}));

let routeModel!: typeof import("../model-router.js").routeModel;

let originalHome: string | undefined;
let testCwd = "";
let testHome = "";

/**
 * Write JSON to a path, creating parent directories when needed.
 *
 * @param filePath - Destination file path
 * @param value - JSON value to write
 * @returns Nothing
 */
function writeJson(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

beforeAll(async () => {
	mockScope.install();
	const mod = await import(`../model-router.js?t=${Date.now()}`);
	routeModel = mod.routeModel;
});

afterAll(() => {
	mockScope.teardown();
});

beforeEach(() => {
	selectModelsMock.mockClear();
	testCwd = mkdtempSync(join(tmpdir(), "tallow-router-select-options-cwd-"));
	testHome = mkdtempSync(join(tmpdir(), "tallow-router-select-options-home-"));
	originalHome = process.env.HOME;
	process.env.HOME = testHome;
});

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	rmSync(testCwd, { force: true, recursive: true });
	rmSync(testHome, { force: true, recursive: true });
});

describe("routeModel selection-option routing mode", () => {
	it("uses configured routing mode when no per-call cost override is present", async () => {
		writeJson(join(testCwd, ".tallow", "settings.json"), {
			routing: {
				mode: "reliable",
			},
		});

		const result = await routeModel(
			"triage this task",
			undefined,
			undefined,
			"claude-opus-4-6",
			undefined,
			undefined,
			testCwd
		);
		expect(result.ok).toBe(true);
		expect(selectModelsMock).toHaveBeenCalledTimes(1);
		const options = selectModelsMock.mock.calls[0]?.[2] as { routingMode?: string };
		expect(options.routingMode).toBe("reliable");
	});

	it("maps auto-cheap keyword to cheap routing mode", async () => {
		writeJson(join(testCwd, ".tallow", "settings.json"), {
			routing: {
				mode: "quality",
			},
		});

		const result = await routeModel(
			"triage this task",
			undefined,
			"auto-cheap",
			"claude-opus-4-6",
			undefined,
			undefined,
			testCwd
		);
		expect(result.ok).toBe(true);
		expect(selectModelsMock).toHaveBeenCalledTimes(1);
		const [_, costPreference, options] = selectModelsMock.mock.calls[0] as [
			unknown,
			string,
			{ routingMode?: string },
		];
		expect(costPreference).toBe("eco");
		expect(options.routingMode).toBe("cheap");
	});

	it("maps per-call premium hint to quality routing mode", async () => {
		writeJson(join(testCwd, ".tallow", "settings.json"), {
			routing: {
				mode: "fast",
			},
		});

		const result = await routeModel(
			"triage this task",
			undefined,
			undefined,
			"claude-opus-4-6",
			undefined,
			{ costPreference: "premium" },
			testCwd
		);
		expect(result.ok).toBe(true);
		expect(selectModelsMock).toHaveBeenCalledTimes(1);
		const [_, costPreference, options] = selectModelsMock.mock.calls[0] as [
			unknown,
			string,
			{ routingMode?: string },
		];
		expect(costPreference).toBe("premium");
		expect(options.routingMode).toBe("quality");
	});
});
