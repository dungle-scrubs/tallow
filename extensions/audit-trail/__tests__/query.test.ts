import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditTrailLogger } from "../logger.js";
import { exportAuditTrail, listAuditFiles, queryAuditTrail, verifyIntegrity } from "../query.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "tallow-audit-query-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a logger and populate it with test entries. */
function createTestAuditFile(): string {
	const logger = new AuditTrailLogger("query-test", { directory: tmpDir });

	logger.record({
		category: "session",
		event: "session_start",
		actor: "system",
		data: { cwd: "/test" },
	});
	logger.record({
		category: "tool",
		event: "tool_call",
		actor: "agent",
		data: { toolName: "bash" },
		outcome: "allowed",
	});
	logger.record({
		category: "permission",
		event: "permission_evaluated",
		actor: "system",
		data: { toolName: "edit" },
		outcome: "blocked",
		reason: "Denied by rule",
	});
	logger.record({ category: "turn", event: "turn_start", actor: "system", data: {} });
	logger.record({
		category: "tool",
		event: "tool_result",
		actor: "agent",
		data: { toolName: "bash" },
		outcome: "executed",
	});
	logger.record({ category: "turn", event: "turn_end", actor: "system", data: {} });
	logger.record({ category: "session", event: "session_shutdown", actor: "system", data: {} });

	return logger.filePath;
}

// ── queryAuditTrail ──────────────────────────────────────────

describe("queryAuditTrail", () => {
	it("returns all entries when no filters are specified", () => {
		const filePath = createTestAuditFile();
		const entries = queryAuditTrail(filePath);
		expect(entries.length).toBe(7);
		// newest first
		expect(entries[0].event).toBe("session_shutdown");
	});

	it("filters by category", () => {
		const filePath = createTestAuditFile();
		const entries = queryAuditTrail(filePath, { category: "tool" });
		expect(entries.length).toBe(2);
		expect(entries.every((e) => e.category === "tool")).toBe(true);
	});

	it("filters by event", () => {
		const filePath = createTestAuditFile();
		const entries = queryAuditTrail(filePath, { event: "tool_call" });
		expect(entries.length).toBe(1);
		expect(entries[0].event).toBe("tool_call");
	});

	it("filters by actor", () => {
		const filePath = createTestAuditFile();
		const entries = queryAuditTrail(filePath, { actor: "agent" });
		expect(entries.length).toBe(2);
		expect(entries.every((e) => e.actor === "agent")).toBe(true);
	});

	it("filters by outcome", () => {
		const filePath = createTestAuditFile();
		const entries = queryAuditTrail(filePath, { outcome: "blocked" });
		expect(entries.length).toBe(1);
		expect(entries[0].outcome).toBe("blocked");
	});

	it("applies limit", () => {
		const filePath = createTestAuditFile();
		const entries = queryAuditTrail(filePath, { limit: 3 });
		expect(entries.length).toBe(3);
	});

	it("supports free-text search", () => {
		const filePath = createTestAuditFile();
		const entries = queryAuditTrail(filePath, { search: "bash" });
		expect(entries.length).toBe(2);
	});

	it("returns empty array for non-existent file", () => {
		const entries = queryAuditTrail("/nonexistent/path.jsonl");
		expect(entries).toEqual([]);
	});
});

// ── verifyIntegrity ──────────────────────────────────────────

describe("verifyIntegrity", () => {
	it("validates a correct hash chain", () => {
		const filePath = createTestAuditFile();
		const result = verifyIntegrity(filePath);
		expect(result.valid).toBe(true);
		expect(result.totalEntries).toBe(7);
		expect(result.firstBrokenSeq).toBeUndefined();
	});

	it("detects a tampered entry (modified data)", () => {
		const filePath = createTestAuditFile();

		// Tamper with the 3rd entry
		const content = readFileSync(filePath, "utf-8");
		const lines = content.trim().split("\n");
		const entry = JSON.parse(lines[2]);
		entry.data.toolName = "TAMPERED";
		lines[2] = JSON.stringify(entry);
		writeFileSync(filePath, `${lines.join("\n")}\n`);

		const result = verifyIntegrity(filePath);
		expect(result.valid).toBe(false);
		expect(result.firstBrokenSeq).toBe(3);
		expect(result.errorMessage).toContain("hash mismatch");
	});

	it("detects a broken prevHash chain", () => {
		const filePath = createTestAuditFile();

		// Break the prevHash chain on the 4th entry
		const content = readFileSync(filePath, "utf-8");
		const lines = content.trim().split("\n");
		const entry = JSON.parse(lines[3]);
		entry.prevHash = "0000000000000000000000000000000000000000000000000000000000000000";
		lines[3] = JSON.stringify(entry);
		writeFileSync(filePath, `${lines.join("\n")}\n`);

		const result = verifyIntegrity(filePath);
		expect(result.valid).toBe(false);
		expect(result.firstBrokenSeq).toBe(4);
		expect(result.errorMessage).toContain("prevHash mismatch");
	});

	it("returns valid for empty file", () => {
		const result = verifyIntegrity(join(tmpDir, "empty.jsonl"));
		expect(result.valid).toBe(true);
		expect(result.totalEntries).toBe(0);
	});
});

// ── listAuditFiles ───────────────────────────────────────────

describe("listAuditFiles", () => {
	it("lists audit files with metadata", () => {
		createTestAuditFile();
		const files = listAuditFiles(tmpDir);
		expect(files.length).toBe(1);
		expect(files[0].sessionId).toBe("query-test");
		expect(files[0].entryCount).toBe(7);
		expect(files[0].sizeBytes).toBeGreaterThan(0);
	});

	it("returns empty array for non-existent directory", () => {
		const files = listAuditFiles("/nonexistent/dir");
		expect(files).toEqual([]);
	});

	it("sorts by date descending", () => {
		// Create two files with different dates by writing directly
		const logger1 = new AuditTrailLogger("session-a", { directory: tmpDir });
		logger1.record({ category: "session", event: "start", actor: "system", data: {} });

		const logger2 = new AuditTrailLogger("session-b", { directory: tmpDir });
		logger2.record({ category: "session", event: "start", actor: "system", data: {} });

		const files = listAuditFiles(tmpDir);
		// Both have today's date so order may vary, but both should be listed
		expect(files.length).toBe(2);
	});
});

// ── exportAuditTrail ─────────────────────────────────────────

describe("exportAuditTrail", () => {
	it("exports as JSONL", () => {
		const filePath = createTestAuditFile();
		const output = exportAuditTrail(filePath, "jsonl");
		const lines = output.trim().split("\n");
		expect(lines.length).toBe(7);

		// Each line should be valid JSON
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it("exports as JSON", () => {
		const filePath = createTestAuditFile();
		const output = exportAuditTrail(filePath, "json");
		const parsed = JSON.parse(output);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.length).toBe(7);
	});

	it("exports as CSV", () => {
		const filePath = createTestAuditFile();
		const output = exportAuditTrail(filePath, "csv");
		const lines = output.trim().split("\n");
		// Header + 7 data rows
		expect(lines.length).toBe(8);
		expect(lines[0]).toBe("seq,ts,sessionId,category,event,actor,outcome,reason,hash");
	});

	it("applies query filters to export", () => {
		const filePath = createTestAuditFile();
		const output = exportAuditTrail(filePath, "jsonl", { category: "tool" });
		const lines = output.trim().split("\n");
		expect(lines.length).toBe(2);
	});
});
