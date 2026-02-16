import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DebugLogger, queryLog } from "../logger.js";

let tmpDir: string;
let logPath: string;

const savedDebug = process.env.TALLOW_DEBUG;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "tallow-debug-query-test-"));
	logPath = join(tmpDir, "debug.log");
	delete process.env.TALLOW_DEBUG;
});

afterEach(() => {
	if (savedDebug !== undefined) {
		process.env.TALLOW_DEBUG = savedDebug;
	} else {
		delete process.env.TALLOW_DEBUG;
	}
	rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Writes a pre-built log with diverse entries for query testing.
 * @returns The logger (already closed) and its log path
 */
function seedLog(): string {
	const logger = new DebugLogger("query-test", tmpDir);

	logger.log("tool", "call", { name: "bash", toolCallId: "tc_1" });
	logger.log("tool", "result", { name: "bash", toolCallId: "tc_1", durationMs: 120, ok: true });
	logger.log("tool", "call", { name: "read", toolCallId: "tc_2" });
	logger.log("tool", "result", { name: "read", toolCallId: "tc_2", durationMs: 5, ok: true });
	logger.log("error", "uncaught_exception", {
		message: "ENOENT: no such file",
		stack: "at fs.readFile",
	});
	logger.log("turn", "start", { turnIndex: 0 });
	logger.log("turn", "end", { turnIndex: 0, toolResultCount: 2 });
	logger.log("subagent", "start", { agentId: "sub_1", agentType: "single", task: "review code" });
	logger.log("subagent", "stop", { agentId: "sub_1", agentType: "single", exitCode: 0 });
	logger.log("model", "select", { provider: "anthropic", modelId: "claude-sonnet-4" });

	logger.close();
	return logger.logPath;
}

// ── queryLog() ───────────────────────────────────────────────

describe("queryLog()", () => {
	it("returns empty array for nonexistent file", () => {
		const result = queryLog("/tmp/does-not-exist-ever.log");
		expect(result).toEqual([]);
	});

	it("returns all entries when no filters specified", () => {
		const path = seedLog();
		// seedLog writes 10 entries + 1 log_start header = 11
		const result = queryLog(path);
		expect(result.length).toBe(11);
	});

	it("returns entries newest-first", () => {
		const path = seedLog();
		const result = queryLog(path);
		// First result should be the last entry written (model/select)
		expect(result[0].cat).toBe("model");
		expect(result[0].evt).toBe("select");
		// Last result should be log_start header
		expect(result[result.length - 1].cat).toBe("session");
		expect(result[result.length - 1].evt).toBe("log_start");
	});

	it("filters by category", () => {
		const path = seedLog();
		const tools = queryLog(path, { category: "tool" });
		expect(tools.length).toBe(4);
		for (const entry of tools) {
			expect(entry.cat).toBe("tool");
		}
	});

	it("filters by event type", () => {
		const path = seedLog();
		const calls = queryLog(path, { eventType: "call" });
		expect(calls.length).toBe(2);
		for (const entry of calls) {
			expect(entry.evt).toBe("call");
		}
	});

	it("combines category and event type filters", () => {
		const path = seedLog();
		const toolCalls = queryLog(path, { category: "tool", eventType: "result" });
		expect(toolCalls.length).toBe(2);
		for (const entry of toolCalls) {
			expect(entry.cat).toBe("tool");
			expect(entry.evt).toBe("result");
		}
	});

	it("applies limit", () => {
		const path = seedLog();
		const limited = queryLog(path, { limit: 3 });
		expect(limited.length).toBe(3);
		// Should be the 3 newest entries
		expect(limited[0].cat).toBe("model");
	});

	it("filters by since timestamp", () => {
		// Write entries with known timestamps by writing raw JSONL
		const ts1 = "2026-01-01T00:00:00.000Z";
		const ts2 = "2026-01-02T00:00:00.000Z";
		const ts3 = "2026-01-03T00:00:00.000Z";

		const lines = [
			JSON.stringify({ ts: ts1, cat: "tool", evt: "call", data: { name: "old" } }),
			JSON.stringify({ ts: ts2, cat: "tool", evt: "call", data: { name: "mid" } }),
			JSON.stringify({ ts: ts3, cat: "tool", evt: "call", data: { name: "new" } }),
		].join("\n");

		writeFileSync(logPath, lines);

		// Only entries after Jan 2
		const result = queryLog(logPath, { since: "2026-01-02T00:00:00.000Z" });
		expect(result.length).toBe(2);
		expect(result[0].data.name).toBe("new");
		expect(result[1].data.name).toBe("mid");
	});

	it("searches across data fields", () => {
		const path = seedLog();
		const result = queryLog(path, { search: "ENOENT" });
		expect(result.length).toBe(1);
		expect(result[0].cat).toBe("error");
	});

	it("searches event names", () => {
		const path = seedLog();
		const result = queryLog(path, { search: "uncaught" });
		expect(result.length).toBe(1);
		expect(result[0].evt).toBe("uncaught_exception");
	});

	it("search is case-insensitive", () => {
		const path = seedLog();
		const result = queryLog(path, { search: "enoent" });
		expect(result.length).toBe(1);
	});

	it("skips malformed JSONL lines", () => {
		writeFileSync(
			logPath,
			[
				'{"ts":"2026-01-01T00:00:00Z","cat":"tool","evt":"call","data":{"name":"bash"}}',
				"this is not json",
				'{"ts":"2026-01-01T00:01:00Z","cat":"tool","evt":"result","data":{"name":"bash"}}',
			].join("\n")
		);

		const result = queryLog(logPath);
		expect(result.length).toBe(2);
	});

	it("combines all filters", () => {
		const path = seedLog();
		const result = queryLog(path, {
			category: "tool",
			eventType: "result",
			search: "bash",
			limit: 1,
		});
		expect(result.length).toBe(1);
		expect(result[0].data.name).toBe("bash");
	});
});
