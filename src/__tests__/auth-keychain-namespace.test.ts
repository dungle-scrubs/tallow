/**
 * Tests for Keychain namespace isolation — each TALLOW_HOME gets its own
 * Keychain entries via deriveKeychainNamespace().
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ApiKeySecretStore,
	createSecureAuthStorage,
	deriveKeychainNamespace,
	persistProviderApiKey,
} from "../auth-hardening.js";

let tempDir: string | undefined;

/**
 * Build a temp directory isolated to one test.
 *
 * @returns Absolute temp directory path
 */
function makeTempDir(): string {
	const dir = join(tmpdir(), `tallow-auth-ns-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDir = dir;
	return dir;
}

/**
 * Read and parse auth.json.
 *
 * @param authPath - auth.json path
 * @returns Parsed auth object
 */
function readAuth(authPath: string): Record<string, { type: string; key: string }> {
	return JSON.parse(readFileSync(authPath, "utf-8")) as Record<
		string,
		{ type: string; key: string }
	>;
}

/**
 * Fake store that records the provider it was called with.
 *
 * @param tag - Prefix for the returned command reference
 * @returns Store and recorded calls
 */
function createFakeStore(tag: string): { store: ApiKeySecretStore; calls: string[] } {
	const calls: string[] = [];
	const store: ApiKeySecretStore = {
		store: (provider, apiKey) => {
			calls.push(`${provider}:${apiKey}`);
			return `!fake-keychain-${tag} ${provider}`;
		},
	};
	return { store, calls };
}

afterEach(() => {
	if (tempDir && existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
	tempDir = undefined;
});

describe("deriveKeychainNamespace", () => {
	test("default tallow home", () => {
		expect(deriveKeychainNamespace("/Users/someone/.tallow/auth.json")).toBe("tallow");
	});

	test("project-siloed tallow home", () => {
		expect(deriveKeychainNamespace("/Users/someone/.tallow-fuse/auth.json")).toBe("tallow-fuse");
	});

	test("custom path without leading dot", () => {
		expect(deriveKeychainNamespace("/opt/tallow-ci/auth.json")).toBe("tallow-ci");
	});

	test("deeply nested path uses immediate parent", () => {
		expect(deriveKeychainNamespace("/a/b/c/.my-config/auth.json")).toBe("my-config");
	});

	test("falls back to 'tallow' for root-level path", () => {
		expect(deriveKeychainNamespace("/auth.json")).toBe("tallow");
	});

	test("falls back to 'tallow' for relative path", () => {
		expect(deriveKeychainNamespace("auth.json")).toBe("tallow");
	});
});

describe("Keychain namespace isolation", () => {
	test("different TALLOW_HOMEs produce different store references via createSecureAuthStorage", () => {
		const root = makeTempDir();
		const homeA = join(root, ".tallow");
		const homeB = join(root, ".tallow-fuse");
		mkdirSync(homeA, { recursive: true });
		mkdirSync(homeB, { recursive: true });

		const refsA: string[] = [];
		const refsB: string[] = [];

		const storeA: ApiKeySecretStore = {
			store: (provider) => {
				const ref = `!security find-generic-password -w -a 'tallow' -s 'tallow.api-key.tallow.${provider}'`;
				refsA.push(ref);
				return ref;
			},
		};
		const storeB: ApiKeySecretStore = {
			store: (provider) => {
				const ref = `!security find-generic-password -w -a 'tallow' -s 'tallow.api-key.tallow-fuse.${provider}'`;
				refsB.push(ref);
				return ref;
			},
		};

		const { authStorage: authA } = createSecureAuthStorage(join(homeA, "auth.json"), {
			secretStore: storeA,
		});
		const { authStorage: authB } = createSecureAuthStorage(join(homeB, "auth.json"), {
			secretStore: storeB,
		});

		authA.set("anthropic", { type: "api_key", key: "sk-key-a" });
		authB.set("anthropic", { type: "api_key", key: "sk-key-b" });

		const dataA = readAuth(join(homeA, "auth.json"));
		const dataB = readAuth(join(homeB, "auth.json"));

		// Each auth.json references a different Keychain service
		expect(dataA.anthropic.key).toContain("tallow.api-key.tallow.anthropic");
		expect(dataB.anthropic.key).toContain("tallow.api-key.tallow-fuse.anthropic");
		expect(dataA.anthropic.key).not.toBe(dataB.anthropic.key);
	});

	test("persistProviderApiKey uses namespace from authPath", () => {
		const root = makeTempDir();
		const home = join(root, ".tallow-project");
		mkdirSync(home, { recursive: true });
		const authPath = join(home, "auth.json");

		const { store, calls } = createFakeStore("project");
		persistProviderApiKey(authPath, "openai", "sk-raw-key", store);

		expect(calls).toEqual(["openai:sk-raw-key"]);
		const data = readAuth(authPath);
		expect(data.openai.key).toBe("!fake-keychain-project openai");
	});
});
