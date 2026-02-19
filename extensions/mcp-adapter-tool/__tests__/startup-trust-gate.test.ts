import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import mcpAdapter from "../index.js";

let cwd: string;
let homeDir: string;
let harness: ExtensionHarness;
let originalHome: string | undefined;
let originalMcpServersFilter: string | undefined;
let originalTrustStatus: string | undefined;
let notifications: Array<{ level: string; message: string }>;

/**
 * Write JSON content to disk, creating parent directories as needed.
 *
 * @param filePath - Target JSON file path
 * @param value - JSON-serializable payload
 * @returns void
 */
function writeJson(filePath: string, value: unknown): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Create a minimal extension context for firing session_start.
 *
 * @returns Extension context with notification tracking
 */
function createContext(): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		ui: {
			notify(message: string, level: string): void {
				notifications.push({ level, message });
			},
			async select() {
				return undefined;
			},
			async confirm() {
				return false;
			},
			async input() {
				return undefined;
			},
			setStatus() {},
			setWorkingMessage() {},
			setWidget() {},
			setFooter() {},
			setHeader() {},
			setTitle() {},
			async custom() {
				return undefined as never;
			},
			pasteToEditor() {},
			setEditorText() {},
			getEditorText() {
				return "";
			},
			async editor() {
				return undefined;
			},
			setEditorComponent() {},
			getToolsExpanded() {
				return false;
			},
			setToolsExpanded() {},
		} as never,
	} as unknown as ExtensionContext;
}

beforeEach(async () => {
	cwd = mkdtempSync(join(tmpdir(), "tallow-mcp-trust-cwd-"));
	homeDir = mkdtempSync(join(tmpdir(), "tallow-mcp-trust-home-"));
	notifications = [];

	originalHome = process.env.HOME;
	originalMcpServersFilter = process.env.PI_MCP_SERVERS;
	originalTrustStatus = process.env.TALLOW_PROJECT_TRUST_STATUS;

	process.env.HOME = homeDir;
	delete process.env.PI_MCP_SERVERS;
	process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";

	harness = ExtensionHarness.create();
	await harness.loadExtension(mcpAdapter);
});

afterEach(() => {
	if (originalHome !== undefined) process.env.HOME = originalHome;
	else delete process.env.HOME;

	if (originalMcpServersFilter !== undefined) {
		process.env.PI_MCP_SERVERS = originalMcpServersFilter;
	} else {
		delete process.env.PI_MCP_SERVERS;
	}

	if (originalTrustStatus !== undefined) {
		process.env.TALLOW_PROJECT_TRUST_STATUS = originalTrustStatus;
	} else {
		delete process.env.TALLOW_PROJECT_TRUST_STATUS;
	}

	rmSync(cwd, { force: true, recursive: true });
	rmSync(homeDir, { force: true, recursive: true });
});

describe("mcp trust gate startup messaging", () => {
	test("warns when project mcpServers are skipped for untrusted projects", async () => {
		writeJson(join(cwd, ".tallow", "settings.json"), {
			mcpServers: {
				project: { command: "project-cmd" },
			},
		});
		process.env.TALLOW_PROJECT_TRUST_STATUS = "untrusted";

		await harness.fireEvent("session_start", { type: "session_start" }, createContext());

		expect(
			notifications.some(
				(n) => n.level === "warning" && n.message.includes("skipped project mcpServers")
			)
		).toBe(true);
		expect(
			notifications.some((n) => n.message.includes(join(cwd, ".tallow", "settings.json")))
		).toBe(true);
	});

	test("does not warn when project trust allows project mcpServers", async () => {
		writeJson(join(cwd, ".tallow", "settings.json"), {
			mcpServers: {
				project: { command: "project-cmd" },
			},
		});
		process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";
		process.env.PI_MCP_SERVERS = "global-only";

		await harness.fireEvent("session_start", { type: "session_start" }, createContext());

		expect(notifications.some((n) => n.message.includes("skipped project mcpServers"))).toBe(false);
	});
});
