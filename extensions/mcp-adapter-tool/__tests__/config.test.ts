import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createTransport,
	loadMcpConfig,
	loadMcpConfigWithMetadata,
	validateMcpConfig,
} from "../index.js";

let cwd: string;
let homeDir: string;
let originalHome: string | undefined;
let originalTrustStatus: string | undefined;

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

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "tallow-mcp-cwd-"));
	homeDir = mkdtempSync(join(tmpdir(), "tallow-mcp-home-"));
	originalHome = process.env.HOME;
	originalTrustStatus = process.env.TALLOW_PROJECT_TRUST_STATUS;
	process.env.HOME = homeDir;
	process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";
});

afterEach(() => {
	if (originalHome !== undefined) process.env.HOME = originalHome;
	else delete process.env.HOME;

	if (originalTrustStatus !== undefined) {
		process.env.TALLOW_PROJECT_TRUST_STATUS = originalTrustStatus;
	} else {
		delete process.env.TALLOW_PROJECT_TRUST_STATUS;
	}

	rmSync(cwd, { recursive: true, force: true });
	rmSync(homeDir, { recursive: true, force: true });
});

describe("validateMcpConfig", () => {
	test("STDIO config without type field (backward compat)", () => {
		const config = validateMcpConfig("fs", { command: "npx", args: ["-y", "server"] });
		expect(config).not.toBeNull();
		expect(config?.type).toBeUndefined();
		expect((config as { command: string }).command).toBe("npx");
	});

	test("STDIO config with explicit type: stdio", () => {
		const config = validateMcpConfig("fs", { type: "stdio", command: "node", args: ["srv.js"] });
		expect(config).not.toBeNull();
		expect(config?.type).toBe("stdio");
		expect((config as { command: string }).command).toBe("node");
	});

	test("SSE config with url", () => {
		const config = validateMcpConfig("remote", {
			type: "sse",
			url: "http://localhost:3100/sse",
			headers: { Authorization: "Bearer xxx" },
		});
		expect(config).not.toBeNull();
		expect(config?.type).toBe("sse");
		expect((config as { url: string }).url).toBe("http://localhost:3100/sse");
		expect((config as { headers: Record<string, string> }).headers?.Authorization).toBe(
			"Bearer xxx"
		);
	});

	test("SSE config without url returns null", () => {
		const config = validateMcpConfig("bad", { type: "sse" });
		expect(config).toBeNull();
	});

	test("Streamable HTTP config with url", () => {
		const config = validateMcpConfig("api", {
			type: "streamable-http",
			url: "http://api.example.com/mcp",
		});
		expect(config).not.toBeNull();
		expect(config?.type).toBe("streamable-http");
		expect((config as { url: string }).url).toBe("http://api.example.com/mcp");
	});

	test("Streamable HTTP config without url returns null", () => {
		const config = validateMcpConfig("bad", { type: "streamable-http" });
		expect(config).toBeNull();
	});

	test("STDIO config without command returns null", () => {
		const config = validateMcpConfig("bad", { args: ["foo"] });
		expect(config).toBeNull();
	});

	test("headers forwarded to SSE config", () => {
		const config = validateMcpConfig("r", {
			type: "sse",
			url: "http://x/sse",
			headers: { "X-Api-Key": "abc" },
		});
		expect((config as { headers: Record<string, string> }).headers?.["X-Api-Key"]).toBe("abc");
	});

	test("env forwarded to all config types", () => {
		const stdio = validateMcpConfig("s", { command: "x", env: { FOO: "1" } });
		expect((stdio as { env: Record<string, string> }).env?.FOO).toBe("1");

		const sse = validateMcpConfig("s", { type: "sse", url: "http://x", env: { BAR: "2" } });
		expect((sse as { env: Record<string, string> }).env?.BAR).toBe("2");
	});
});

describe("loadMcpConfig trust gating", () => {
	test("trusted projects merge global and project mcpServers", () => {
		writeJson(join(homeDir, ".tallow", "settings.json"), {
			mcpServers: {
				global: { command: "global-cmd" },
				shared: { command: "global-shared" },
			},
		});
		writeJson(join(cwd, ".tallow", "settings.json"), {
			mcpServers: {
				project: { command: "project-cmd" },
				shared: { command: "project-shared" },
			},
		});

		process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";
		const config = loadMcpConfig(cwd);

		expect(Object.keys(config)).toEqual(["global", "shared", "project"]);
		expect((config.global as { command?: string }).command).toBe("global-cmd");
		expect((config.project as { command?: string }).command).toBe("project-cmd");
		expect((config.shared as { command?: string }).command).toBe("project-shared");
	});

	test("untrusted projects ignore project mcpServers and report skipped source", () => {
		writeJson(join(homeDir, ".tallow", "settings.json"), {
			mcpServers: {
				global: { command: "global-cmd" },
			},
		});
		writeJson(join(cwd, ".tallow", "settings.json"), {
			mcpServers: {
				project: { command: "project-cmd" },
			},
		});

		process.env.TALLOW_PROJECT_TRUST_STATUS = "untrusted";
		const result = loadMcpConfigWithMetadata(cwd);
		expect(Object.keys(result.config)).toEqual(["global"]);
		expect((result.config.global as { command?: string }).command).toBe("global-cmd");
		expect(result.skippedProjectConfig).not.toBeNull();
		expect(result.skippedProjectConfig?.path).toBe(join(cwd, ".tallow", "settings.json"));
		expect(result.skippedProjectConfig?.trustStatus).toBe("untrusted");
	});

	test("invalid project mcp config is ignored without blocking global config", () => {
		writeJson(join(homeDir, ".tallow", "settings.json"), {
			mcpServers: {
				global: { command: "global-cmd" },
			},
		});
		mkdirSync(join(cwd, ".tallow"), { recursive: true });
		writeFileSync(join(cwd, ".tallow", "settings.json"), "{ invalid-json");

		process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";
		const config = loadMcpConfig(cwd);
		expect(Object.keys(config)).toEqual(["global"]);
		expect((config.global as { command?: string }).command).toBe("global-cmd");
	});
});

describe("createTransport", () => {
	test("creates StdioTransport for STDIO config", () => {
		const t = createTransport("fs", { command: "echo" });
		expect(t.type).toBe("stdio");
		expect(t.connected).toBe(false);
	});

	test("creates StdioTransport for explicit type: stdio", () => {
		const t = createTransport("fs", { type: "stdio", command: "echo" });
		expect(t.type).toBe("stdio");
	});

	test("creates SseTransport for SSE config", () => {
		const t = createTransport("remote", { type: "sse", url: "http://localhost/sse" });
		expect(t.type).toBe("sse");
		expect(t.connected).toBe(false);
	});

	test("creates StreamableHttpTransport for streamable-http config", () => {
		const t = createTransport("api", {
			type: "streamable-http",
			url: "http://localhost/mcp",
		});
		expect(t.type).toBe("streamable-http");
		expect(t.connected).toBe(false);
	});
});
