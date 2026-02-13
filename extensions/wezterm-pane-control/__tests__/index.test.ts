import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import weztermPaneControl, {
	buildSplitCommandArgs,
	executeWeztermAction,
	filterPanesToCurrentTab,
	type WeztermCliResult,
	type WeztermPaneInfo,
} from "../index.js";

const ORIGINAL_WEZTERM_PANE = process.env.WEZTERM_PANE;

/**
 * Restore WEZTERM_PANE after each test.
 * @returns Nothing
 */
afterEach(() => {
	if (ORIGINAL_WEZTERM_PANE === undefined) {
		delete process.env.WEZTERM_PANE;
		return;
	}
	process.env.WEZTERM_PANE = ORIGINAL_WEZTERM_PANE;
});

/**
 * Create a minimal mock ExtensionAPI for registration tests.
 * @returns Mock API instance and captured calls
 */
function createMockPi(): {
	readonly api: ExtensionAPI;
	readonly registerToolCalls: unknown[];
	readonly onCalls: Array<{ readonly event: string; readonly handler: unknown }>;
} {
	const registerToolCalls: unknown[] = [];
	const onCalls: Array<{ readonly event: string; readonly handler: unknown }> = [];

	return {
		registerToolCalls,
		onCalls,
		api: {
			registerTool(tool: unknown) {
				registerToolCalls.push(tool);
			},
			on(event: string, handler: unknown) {
				onCalls.push({ event, handler });
			},
		} as unknown as ExtensionAPI,
	};
}

/**
 * Build a pane fixture with sensible defaults.
 * @param overrides - Field overrides for the pane fixture
 * @returns Pane fixture
 */
function pane(overrides: Partial<WeztermPaneInfo>): WeztermPaneInfo {
	return {
		pane_id: 10,
		tab_id: 1,
		title: "zsh",
		cwd: "file:///tmp/project",
		is_active: false,
		is_zoomed: false,
		size: { rows: 40, cols: 120 },
		...overrides,
	};
}

/**
 * Create a CLI result object for mocked wezterm calls.
 * @param stdout - Command stdout
 * @param stderr - Command stderr
 * @param status - Exit status code
 * @returns Mock CLI result
 */
function cli(stdout: string, stderr = "", status = 0): WeztermCliResult {
	return { stdout, stderr, status };
}

describe("wezterm-pane-control registration", () => {
	it("does not register when WEZTERM_PANE is missing", () => {
		delete process.env.WEZTERM_PANE;
		const mockPi = createMockPi();

		weztermPaneControl(mockPi.api);

		expect(mockPi.registerToolCalls.length).toBe(0);
		expect(mockPi.onCalls.length).toBe(0);
	});
});

describe("filterPanesToCurrentTab", () => {
	it("returns only panes from the active tab", () => {
		const panes = [
			pane({ pane_id: 10, tab_id: 1 }),
			pane({ pane_id: 11, tab_id: 1 }),
			pane({ pane_id: 20, tab_id: 2 }),
		];

		const result = filterPanesToCurrentTab(panes, 10);

		expect(result.tabId).toBe(1);
		expect(result.panes.map((p) => p.pane_id)).toEqual([10, 11]);
	});
});

describe("buildSplitCommandArgs", () => {
	it("maps split params to wezterm cli args", () => {
		const args = buildSplitCommandArgs(
			{
				direction: "right",
				percent: 30,
				command: ["tallow", "--model", "claude-sonnet-4-20250514"],
				cwd: "/Users/kevin/dev/tallow",
			},
			18
		);

		expect(args).toEqual([
			"split-pane",
			"--pane-id",
			"18",
			"--right",
			"--percent",
			"30",
			"--cwd",
			"/Users/kevin/dev/tallow",
			"--",
			"tallow",
			"--model",
			"claude-sonnet-4-20250514",
		]);
	});
});

describe("executeWeztermAction", () => {
	it("list filters panes to the current tab", () => {
		const listJson = JSON.stringify([
			pane({ pane_id: 10, tab_id: 1, title: "main" }),
			pane({ pane_id: 11, tab_id: 1, title: "logs" }),
			pane({ pane_id: 20, tab_id: 2, title: "other" }),
		]);

		const result = executeWeztermAction(
			{ action: "list" },
			{
				currentPaneId: 10,
				runCli: () => cli(listJson),
			}
		);

		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("pane 10");
		expect(result.content[0].text).toContain("pane 11");
		expect(result.content[0].text).not.toContain("pane 20");
		expect(result.details?.tabId).toBe(1);
	});

	it("split builds expected cli invocation", () => {
		let capturedArgs: readonly string[] = [];
		const result = executeWeztermAction(
			{
				action: "split",
				direction: "right",
				percent: 25,
				command: ["tallow"],
			},
			{
				currentPaneId: 18,
				runCli: (args) => {
					capturedArgs = args;
					return cli("52\n");
				},
			}
		);

		expect(capturedArgs).toEqual([
			"split-pane",
			"--pane-id",
			"18",
			"--right",
			"--percent",
			"25",
			"--",
			"tallow",
		]);
		expect(result.content[0].text).toContain("new pane 52");
	});

	it("close defaults to current pane and includes self-close warning", () => {
		let capturedArgs: readonly string[] = [];
		const result = executeWeztermAction(
			{ action: "close" },
			{
				currentPaneId: 18,
				runCli: (args) => {
					capturedArgs = args;
					return cli("");
				},
			}
		);

		expect(capturedArgs).toEqual(["kill-pane", "--pane-id", "18"]);
		expect(result.content[0].text).toContain("Closing current pane (pane 18)");
		expect(result.content[0].text).toContain("✓ Closed pane 18");
	});

	it("close targets explicit pane id", () => {
		let capturedArgs: readonly string[] = [];
		const result = executeWeztermAction(
			{ action: "close", paneId: 25 },
			{
				currentPaneId: 18,
				runCli: (args) => {
					capturedArgs = args;
					return cli("");
				},
			}
		);

		expect(capturedArgs).toEqual(["kill-pane", "--pane-id", "25"]);
		expect(result.content[0].text).toBe("✓ Closed pane 25");
	});

	it("focus by direction uses activate-pane-direction", () => {
		let capturedArgs: readonly string[] = [];
		const result = executeWeztermAction(
			{ action: "focus", direction: "left" },
			{
				currentPaneId: 18,
				runCli: (args) => {
					capturedArgs = args;
					return cli("");
				},
			}
		);

		expect(capturedArgs).toEqual(["activate-pane-direction", "--pane-id", "18", "Left"]);
		expect(result.content[0].text).toContain("left");
	});

	it("focus by pane id uses activate-pane", () => {
		let capturedArgs: readonly string[] = [];
		const result = executeWeztermAction(
			{ action: "focus", paneId: 42 },
			{
				currentPaneId: 18,
				runCli: (args) => {
					capturedArgs = args;
					return cli("");
				},
			}
		);

		expect(capturedArgs).toEqual(["activate-pane", "--pane-id", "42"]);
		expect(result.content[0].text).toContain("pane 42");
	});

	it("returns tool error when wezterm cli command fails", () => {
		const result = executeWeztermAction(
			{ action: "move_to_tab", paneId: 999 },
			{
				currentPaneId: 18,
				runCli: () => cli("", "pane not found", 1),
			}
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("pane not found");
	});
});
