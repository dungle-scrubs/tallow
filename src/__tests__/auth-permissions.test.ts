import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSecureAuthFilePermissions, resolveRuntimeApiKeyFromEnv } from "../auth-hardening.js";

let tempDir: string | undefined;

/**
 * Build a temp directory isolated to one test.
 *
 * @returns Absolute temp directory path
 */
function makeTempDir(): string {
	const dir = join(
		tmpdir(),
		`tallow-auth-perm-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	tempDir = dir;
	return dir;
}

afterEach(() => {
	if (tempDir && existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
	tempDir = undefined;
	delete process.env.TALLOW_API_KEY;
	delete process.env.TALLOW_API_KEY_REF;
	delete process.env.TEST_RUNTIME_API_KEY;
});

describe("assertSecureAuthFilePermissions", () => {
	test("accepts auth.json with 0600 mode", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, "{}", { mode: 0o600 });

		expect(() => assertSecureAuthFilePermissions(authPath)).not.toThrow();
	});

	test("fails when auth.json mode is not 0600", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, "{}", { mode: 0o600 });
		chmodSync(authPath, 0o644);

		expect(() => assertSecureAuthFilePermissions(authPath)).toThrow("expected 0600");
	});

	test("skips missing auth.json", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");

		expect(() => assertSecureAuthFilePermissions(authPath)).not.toThrow();
	});
});

describe("resolveRuntimeApiKeyFromEnv", () => {
	test("prefers TALLOW_API_KEY when provided", () => {
		process.env.TALLOW_API_KEY = "raw-runtime-key";
		expect(resolveRuntimeApiKeyFromEnv()).toBe("raw-runtime-key");
	});

	test("resolves TALLOW_API_KEY_REF as env var indirection", () => {
		process.env.TEST_RUNTIME_API_KEY = "indirected-runtime-key";
		process.env.TALLOW_API_KEY_REF = "TEST_RUNTIME_API_KEY";
		expect(resolveRuntimeApiKeyFromEnv()).toBe("indirected-runtime-key");
	});

	test("rejects when both runtime env inputs are set", () => {
		process.env.TALLOW_API_KEY = "raw-runtime-key";
		process.env.TALLOW_API_KEY_REF = "TEST_RUNTIME_API_KEY";
		expect(() => resolveRuntimeApiKeyFromEnv()).toThrow("not both");
	});
});
