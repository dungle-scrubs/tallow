import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditTrailLogger, computeEntryHash, isSensitiveKey } from "../logger.js";
import type { AuditEntry } from "../types.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "tallow-audit-logger-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function readEntries(filePath: string): AuditEntry[] {
	if (!existsSync(filePath)) return [];
	return readFileSync(filePath, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

// ── AuditTrailLogger ─────────────────────────────────────────

describe("AuditTrailLogger", () => {
	it("creates an audit file and writes entries", () => {
		const logger = new AuditTrailLogger("test-session-1", { directory: tmpDir });

		logger.record({
			category: "session",
			event: "session_start",
			actor: "system",
			data: { cwd: "/test" },
		});

		expect(existsSync(logger.filePath)).toBe(true);

		const entries = readEntries(logger.filePath);
		expect(entries.length).toBe(1);
		expect(entries[0].seq).toBe(1);
		expect(entries[0].sessionId).toBe("test-session-1");
		expect(entries[0].category).toBe("session");
		expect(entries[0].event).toBe("session_start");
		expect(entries[0].actor).toBe("system");
		expect(entries[0].data.cwd).toBe("/test");
	});

	it("assigns monotonically increasing sequence numbers", () => {
		const logger = new AuditTrailLogger("test-seq", { directory: tmpDir });

		logger.record({ category: "session", event: "start", actor: "system", data: {} });
		logger.record({ category: "tool", event: "tool_call", actor: "agent", data: {} });
		logger.record({ category: "turn", event: "turn_end", actor: "system", data: {} });

		const entries = readEntries(logger.filePath);
		expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
	});

	it("builds a valid SHA-256 hash chain", () => {
		const logger = new AuditTrailLogger("test-hash-chain", { directory: tmpDir });

		logger.record({ category: "session", event: "start", actor: "system", data: {} });
		logger.record({ category: "tool", event: "call", actor: "agent", data: {} });
		logger.record({ category: "turn", event: "end", actor: "system", data: {} });

		const entries = readEntries(logger.filePath);

		// First entry has empty prevHash
		expect(entries[0].prevHash).toBe("");

		// Each entry's prevHash matches the previous entry's hash
		for (let i = 1; i < entries.length; i++) {
			expect(entries[i].prevHash).toBe(entries[i - 1].hash);
		}

		// Each entry's hash is valid
		for (const entry of entries) {
			const { hash: storedHash, ...rest } = entry;
			const expectedHash = computeEntryHash(rest as Omit<AuditEntry, "hash">);
			expect(storedHash).toBe(expectedHash);
		}
	});

	it("records optional before/after/outcome/reason fields", () => {
		const logger = new AuditTrailLogger("test-optional", { directory: tmpDir });

		logger.record({
			category: "permission",
			event: "permission_evaluated",
			actor: "system",
			data: { toolName: "bash" },
			before: { state: "pending" },
			after: { state: "allowed" },
			outcome: "allowed",
			reason: "Rule matched",
		});

		const entries = readEntries(logger.filePath);
		expect(entries[0].before).toEqual({ state: "pending" });
		expect(entries[0].after).toEqual({ state: "allowed" });
		expect(entries[0].outcome).toBe("allowed");
		expect(entries[0].reason).toBe("Rule matched");
	});

	it("omits undefined optional fields from JSON", () => {
		const logger = new AuditTrailLogger("test-omit", { directory: tmpDir });

		logger.record({
			category: "session",
			event: "start",
			actor: "system",
			data: {},
		});

		const entries = readEntries(logger.filePath);
		expect("before" in entries[0]).toBe(false);
		expect("after" in entries[0]).toBe(false);
		expect("outcome" in entries[0]).toBe(false);
		expect("reason" in entries[0]).toBe(false);
	});

	it("resumes seq and hash chain from existing file", () => {
		const logger1 = new AuditTrailLogger("test-resume", { directory: tmpDir });
		logger1.record({ category: "session", event: "start", actor: "system", data: {} });
		logger1.record({ category: "tool", event: "call", actor: "agent", data: {} });

		const lastHash = logger1.getLastHash();
		const lastSeq = logger1.getSeq();

		// Create new logger for same session/file
		const logger2 = new AuditTrailLogger("test-resume", { directory: tmpDir });
		expect(logger2.getSeq()).toBe(lastSeq);
		expect(logger2.getLastHash()).toBe(lastHash);

		// New entry should chain correctly
		logger2.record({ category: "turn", event: "end", actor: "system", data: {} });
		const entries = readEntries(logger2.filePath);
		expect(entries.length).toBe(3);
		expect(entries[2].seq).toBe(3);
		expect(entries[2].prevHash).toBe(lastHash);
	});

	it("returns null when disabled", () => {
		const logger = new AuditTrailLogger("test-disabled", {
			directory: tmpDir,
			enabled: false,
		});

		const result = logger.record({
			category: "session",
			event: "start",
			actor: "system",
			data: {},
		});

		expect(result).toBeNull();
		const entries = readEntries(logger.filePath);
		expect(entries.length).toBe(0);
	});

	it("excludes entries for excluded categories", () => {
		const logger = new AuditTrailLogger("test-exclude", {
			directory: tmpDir,
			excludeCategories: ["turn", "model"],
		});

		logger.record({ category: "session", event: "start", actor: "system", data: {} });
		const excluded = logger.record({
			category: "turn",
			event: "turn_start",
			actor: "system",
			data: {},
		});
		logger.record({ category: "tool", event: "call", actor: "agent", data: {} });

		expect(excluded).toBeNull();
		const entries = readEntries(logger.filePath);
		expect(entries.length).toBe(2);
		expect(entries.map((e) => e.category)).toEqual(["session", "tool"]);
	});
});

// ── Sensitive key redaction ──────────────────────────────────

describe("isSensitiveKey", () => {
	it("redacts common sensitive keys", () => {
		expect(isSensitiveKey("password")).toBe(true);
		expect(isSensitiveKey("apiKey")).toBe(true);
		expect(isSensitiveKey("secret")).toBe(true);
		expect(isSensitiveKey("token")).toBe(true);
		expect(isSensitiveKey("authorization")).toBe(true);
		expect(isSensitiveKey("credentials")).toBe(true);
	});

	it("does not redact normal keys", () => {
		expect(isSensitiveKey("name")).toBe(false);
		expect(isSensitiveKey("command")).toBe(false);
		expect(isSensitiveKey("toolName")).toBe(false);
		expect(isSensitiveKey("cwd")).toBe(false);
	});
});

describe("redaction in logger", () => {
	it("redacts sensitive fields in data", () => {
		const logger = new AuditTrailLogger("test-redact", {
			directory: tmpDir,
			redactSensitive: true,
		});

		logger.record({
			category: "tool",
			event: "call",
			actor: "agent",
			data: {
				command: "curl",
				apiKey: "sk-secret-123",
				nested: { password: "hunter2", safe: "visible" },
			},
		});

		const entries = readEntries(logger.filePath);
		expect(entries[0].data.command).toBe("curl");
		expect(entries[0].data.apiKey).toBe("[REDACTED]");
		expect((entries[0].data.nested as Record<string, unknown>).password).toBe("[REDACTED]");
		expect((entries[0].data.nested as Record<string, unknown>).safe).toBe("visible");
	});

	it("does not redact when redactSensitive is false", () => {
		const logger = new AuditTrailLogger("test-no-redact", {
			directory: tmpDir,
			redactSensitive: false,
		});

		logger.record({
			category: "tool",
			event: "call",
			actor: "agent",
			data: { apiKey: "sk-secret-123" },
		});

		const entries = readEntries(logger.filePath);
		expect(entries[0].data.apiKey).toBe("sk-secret-123");
	});
});

// ── computeEntryHash ─────────────────────────────────────────

describe("computeEntryHash", () => {
	it("produces consistent hashes for the same input", () => {
		const entry = {
			seq: 1,
			ts: "2026-01-01T00:00:00.000Z",
			sessionId: "test",
			category: "session" as const,
			event: "start",
			actor: "system" as const,
			data: {},
			prevHash: "",
		};

		const hash1 = computeEntryHash(entry);
		const hash2 = computeEntryHash(entry);
		expect(hash1).toBe(hash2);
		expect(hash1).toMatch(/^[a-f0-9]{64}$/);
	});

	it("produces different hashes for different inputs", () => {
		const base = {
			seq: 1,
			ts: "2026-01-01T00:00:00.000Z",
			sessionId: "test",
			category: "session" as const,
			event: "start",
			actor: "system" as const,
			data: {},
			prevHash: "",
		};

		const hash1 = computeEntryHash(base);
		const hash2 = computeEntryHash({ ...base, seq: 2 });
		expect(hash1).not.toBe(hash2);
	});
});
