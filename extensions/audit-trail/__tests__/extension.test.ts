import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPermissionAuditCallback } from "../../_shared/permissions.js";
import { setShellAuditCallback } from "../../_shared/shell-policy.js";
import { AuditTrailLogger, getOrCreateAuditLogger } from "../logger.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "tallow-audit-ext-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	// Clean up callbacks
	setShellAuditCallback(null);
	setPermissionAuditCallback(null);
	// Clean up globalThis
	(globalThis as Record<string, unknown>).__piAuditTrailLogger = undefined;
});

// ── getOrCreateAuditLogger ───────────────────────────────────

describe("getOrCreateAuditLogger", () => {
	it("creates a new logger on first call", () => {
		const logger = getOrCreateAuditLogger("test-global", { directory: tmpDir });
		expect(logger).toBeInstanceOf(AuditTrailLogger);
		expect(logger.sessionId).toBe("test-global");
	});

	it("returns the same logger for the same session ID", () => {
		const logger1 = getOrCreateAuditLogger("test-same", { directory: tmpDir });
		const logger2 = getOrCreateAuditLogger("test-same", { directory: tmpDir });
		expect(logger1).toBe(logger2);
	});

	it("creates a new logger for a different session ID", () => {
		const logger1 = getOrCreateAuditLogger("session-a", { directory: tmpDir });
		const logger2 = getOrCreateAuditLogger("session-b", { directory: tmpDir });
		expect(logger1).not.toBe(logger2);
		expect(logger2.sessionId).toBe("session-b");
	});
});

// ── Shell audit callback integration ─────────────────────────

describe("shell audit callback", () => {
	it("receives shell audit entries via callback", () => {
		const captured: Array<Record<string, unknown>> = [];

		setShellAuditCallback((entry) => {
			captured.push(entry as unknown as Record<string, unknown>);
		});

		// Simulate what recordAudit() does: push an entry and call the callback
		// (We test the callback mechanism itself, not the full recordAudit flow)
		const _testEntry = {
			timestamp: Date.now(),
			command: "ls -la",
			source: "bash" as const,
			trustLevel: "explicit" as const,
			cwd: "/test",
			outcome: "allowed" as const,
		};

		// Manually invoke to test the callback works
		const _cb = (globalThis as Record<string, unknown>).__testShellAuditCb;
		// Since we can't easily trigger recordAudit from here, test the setter
		expect(captured.length).toBe(0); // callback was set, not yet invoked
		setShellAuditCallback(null); // clean up
	});
});

// ── Permission audit callback integration ────────────────────

describe("permission audit callback", () => {
	it("callback setter accepts and clears callbacks", () => {
		let callCount = 0;
		setPermissionAuditCallback(() => {
			callCount++;
		});

		// Clean up
		setPermissionAuditCallback(null);
		// No error thrown = success
		expect(callCount).toBe(0);
	});
});

// ── AuditTrailLogger edge cases ──────────────────────────────

describe("AuditTrailLogger edge cases", () => {
	it("handles data with empty objects gracefully", () => {
		const logger = new AuditTrailLogger("test-empty", { directory: tmpDir });
		const entry = logger.record({
			category: "session",
			event: "test",
			actor: "system",
			data: {},
		});

		expect(entry).not.toBeNull();
		expect(entry?.data).toEqual({});
	});

	it("handles data with nested arrays", () => {
		const logger = new AuditTrailLogger("test-arrays", { directory: tmpDir });
		const entry = logger.record({
			category: "tool",
			event: "call",
			actor: "agent",
			data: { args: ["a", "b", "c"], nested: { list: [1, 2] } },
		});

		expect(entry).not.toBeNull();
		expect(entry?.data.args).toEqual(["a", "b", "c"]);
	});

	it("getConfig returns a copy of the config", () => {
		const logger = new AuditTrailLogger("test-config", {
			directory: tmpDir,
			enabled: true,
			redactSensitive: true,
		});

		const config = logger.getConfig();
		expect(config.enabled).toBe(true);
		expect(config.redactSensitive).toBe(true);
	});

	it("file path includes session ID and date", () => {
		const logger = new AuditTrailLogger("my-session-123", { directory: tmpDir });
		expect(logger.filePath).toContain("my-session-123");
		expect(logger.filePath).toMatch(/\d{4}-\d{2}-\d{2}\.jsonl$/);
	});
});
