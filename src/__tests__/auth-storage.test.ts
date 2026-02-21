import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApiKeySecretStore, createSecureAuthStorage } from "../auth-hardening.js";

let tempDir: string | undefined;

/**
 * Build a temp directory isolated to one test.
 *
 * @returns Absolute temp directory path
 */
function makeTempDir(): string {
	const dir = join(
		tmpdir(),
		`tallow-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	tempDir = dir;
	return dir;
}

/**
 * Read and parse auth.json for assertions.
 *
 * @param authPath - auth.json path
 * @returns Parsed auth object
 */
function readAuth(authPath: string): Record<string, unknown> {
	return JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
}

afterEach(() => {
	if (tempDir && existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
	tempDir = undefined;
});

describe("createSecureAuthStorage", () => {
	test("persists api_key credentials as store-backed references", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const calls: Array<{ provider: string; apiKey: string }> = [];
		const fakeStore: ApiKeySecretStore = {
			store: (provider, apiKey) => {
				calls.push({ provider, apiKey });
				return `!fake-secret-store ${provider}`;
			},
		};

		const { authStorage } = createSecureAuthStorage(authPath, { secretStore: fakeStore });
		authStorage.set("anthropic", { type: "api_key", key: "sk-ant-secret" });

		expect(calls).toEqual([{ provider: "anthropic", apiKey: "sk-ant-secret" }]);
		const data = readAuth(authPath);
		expect(data.anthropic).toEqual({ type: "api_key", key: "!fake-secret-store anthropic" });
	});

	test("converts op:// references to opchain command references", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const fakeStore: ApiKeySecretStore = {
			store: () => {
				throw new Error("store() must not run for op:// references");
			},
		};

		const { authStorage } = createSecureAuthStorage(authPath, { secretStore: fakeStore });
		authStorage.set("anthropic", {
			type: "api_key",
			key: "op://Services/Anthropic/api-key",
		});

		const data = readAuth(authPath);
		expect(data.anthropic).toEqual({
			type: "api_key",
			key: "!opchain --read op read 'op://Services/Anthropic/api-key'",
		});
	});

	test("leaves oauth credentials untouched", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { authStorage } = createSecureAuthStorage(authPath, {
			secretStore: {
				store: () => "!unused",
			},
		});

		authStorage.set("github", {
			type: "oauth",
			access_token: "tok",
			refresh_token: "refresh",
			expires: Date.now() + 60_000,
			token_type: "bearer",
		});

		const data = readAuth(authPath);
		expect(data.github).toEqual({
			type: "oauth",
			access_token: "tok",
			refresh_token: "refresh",
			expires: expect.any(Number),
			token_type: "bearer",
		});
	});
});
