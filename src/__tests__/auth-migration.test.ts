import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ApiKeySecretStore,
	migratePlaintextApiKeys,
	persistProviderApiKey,
} from "../auth-hardening.js";

let tempDir: string | undefined;

/**
 * Build a temp directory isolated to one test.
 *
 * @returns Absolute temp directory path
 */
function makeTempDir(): string {
	const dir = join(
		tmpdir(),
		`tallow-auth-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

describe("migratePlaintextApiKeys", () => {
	test("migrates plaintext API keys and keeps existing references", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify(
				{
					anthropic: { type: "api_key", key: "sk-ant-raw" },
					openai: { type: "api_key", key: "OPENAI_API_KEY" },
					google: { type: "api_key", key: "op://Services/Google/api-key" },
					xai: { type: "api_key", key: "UPPERCASEONLYTOKEN" },
				},
				null,
				2
			)
		);

		const calls: string[] = [];
		const fakeStore: ApiKeySecretStore = {
			store: (provider) => {
				calls.push(provider);
				return `!fake-store ${provider}`;
			},
		};

		const result = migratePlaintextApiKeys(authPath, fakeStore);
		expect(result.migratedProviders).toEqual(["anthropic", "google", "xai"]);
		expect(calls).toEqual(["anthropic", "xai"]);

		const data = readAuth(authPath);
		expect(data.anthropic).toEqual({ type: "api_key", key: "!fake-store anthropic" });
		expect(data.openai).toEqual({ type: "api_key", key: "OPENAI_API_KEY" });
		expect(data.google).toEqual({
			type: "api_key",
			key: "!opchain --read op read 'op://Services/Google/api-key'",
		});
		expect(data.xai).toEqual({ type: "api_key", key: "!fake-store xai" });
	});

	test("throws when plaintext migration has no supported secret store", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "raw-key" } }));

		const failingStore: ApiKeySecretStore = {
			store: () => {
				throw new Error("no secure backend");
			},
		};

		expect(() => migratePlaintextApiKeys(authPath, failingStore)).toThrow("no secure backend");
	});
});

describe("persistProviderApiKey", () => {
	test("stores provider credentials using the secure store", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");

		const mode = persistProviderApiKey(authPath, "anthropic", "raw-key", {
			store: () => "!security find-generic-password -w -a 'tallow' -s 'tallow.api-key.anthropic'",
		});

		expect(mode).toBe("keychain");
		const data = readAuth(authPath);
		expect(data.anthropic).toEqual({
			type: "api_key",
			key: "!security find-generic-password -w -a 'tallow' -s 'tallow.api-key.anthropic'",
		});
	});
});
