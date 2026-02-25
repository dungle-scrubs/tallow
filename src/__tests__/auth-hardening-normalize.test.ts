/**
 * Tests for normalizeApiKeyValue and shell command reference edge cases
 * in auth-hardening.ts.
 *
 * These test the input normalization pipeline that decides whether a key value
 * is a raw secret, a command reference, an op:// reference, or an env var name.
 * The public API (persistProviderApiKey) is the primary test surface since
 * normalizeApiKeyValue is private.
 */
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
		`tallow-auth-norm-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
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

/** Fake store that records calls and returns a command reference. */
function createFakeStore(): { store: ApiKeySecretStore; calls: string[] } {
	const calls: string[] = [];
	const store: ApiKeySecretStore = {
		store: (provider, apiKey) => {
			calls.push(`${provider}:${apiKey}`);
			return `!fake-keychain ${provider}`;
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

describe("normalizeApiKeyValue via persistProviderApiKey", () => {
	test("preserves existing !command references unchanged", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { store, calls } = createFakeStore();

		persistProviderApiKey(authPath, "anthropic", "!pass show api-key", store);

		const data = readAuth(authPath);
		expect(data.anthropic.key).toBe("!pass show api-key");
		expect(calls).toHaveLength(0); // Store not called for existing refs
	});

	test("converts op:// references to opchain command references", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { store, calls } = createFakeStore();

		persistProviderApiKey(authPath, "openai", "op://Services/OpenAI/api-key", store);

		const data = readAuth(authPath);
		expect(data.openai.key).toBe("!opchain --read op read 'op://Services/OpenAI/api-key'");
		expect(calls).toHaveLength(0); // Store not called for op:// refs
	});

	test("preserves ENV_VAR_NAME references unchanged", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { store, calls } = createFakeStore();

		persistProviderApiKey(authPath, "anthropic", "ANTHROPIC_API_KEY", store);

		const data = readAuth(authPath);
		expect(data.anthropic.key).toBe("ANTHROPIC_API_KEY");
		expect(calls).toHaveLength(0);
	});

	test("sends raw keys to the secret store", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { store, calls } = createFakeStore();

		persistProviderApiKey(authPath, "anthropic", "sk-ant-raw-key-123", store);

		expect(calls).toEqual(["anthropic:sk-ant-raw-key-123"]);
		const data = readAuth(authPath);
		expect(data.anthropic.key).toBe("!fake-keychain anthropic");
	});

	test("trims whitespace from key input", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { store, calls } = createFakeStore();

		persistProviderApiKey(authPath, "anthropic", "  ANTHROPIC_API_KEY  ", store);

		expect(data(authPath).anthropic.key).toBe("ANTHROPIC_API_KEY");
		expect(calls).toHaveLength(0);

		function data(p: string): Record<string, { key: string }> {
			return JSON.parse(readFileSync(p, "utf-8")) as Record<string, { key: string }>;
		}
	});

	test("throws on empty key input", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { store } = createFakeStore();

		expect(() => persistProviderApiKey(authPath, "anthropic", "", store)).toThrow("Empty API key");
	});

	test("throws on whitespace-only key input", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { store } = createFakeStore();

		expect(() => persistProviderApiKey(authPath, "anthropic", "   ", store)).toThrow(
			"Empty API key"
		);
	});
});

describe("ENV_VAR_NAME pattern matching", () => {
	test("single-word uppercase is NOT an env var (no underscore)", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { store, calls } = createFakeStore();

		// "MYTOKEN" has no underscore — doesn't match the ENV_REFERENCE_PATTERN
		persistProviderApiKey(authPath, "test", "MYTOKEN", store);

		// Should be treated as raw key → sent to store
		expect(calls).toHaveLength(1);
	});

	test("uppercase with underscore is treated as env var reference", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { store, calls } = createFakeStore();

		persistProviderApiKey(authPath, "test", "MY_TOKEN", store);

		expect(calls).toHaveLength(0);
		const data = readAuth(authPath);
		expect(data.test.key).toBe("MY_TOKEN");
	});

	test("mixed case is NOT treated as env var reference", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { store, calls } = createFakeStore();

		persistProviderApiKey(authPath, "test", "My_Token", store);

		// Mixed case doesn't match /^[A-Z][A-Z0-9]*_[A-Z0-9_]*$/ → raw key
		expect(calls).toHaveLength(1);
	});
});

describe("migratePlaintextApiKeys edge cases", () => {
	test("returns empty array for non-existent auth file", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "nonexistent-auth.json");
		const { store } = createFakeStore();

		const result = migratePlaintextApiKeys(authPath, store);

		expect(result.migratedProviders).toEqual([]);
	});

	test("skips non-api_key credential types", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				provider1: { type: "oauth", token: "some-token" },
				provider2: { type: "api_key", key: "ALREADY_A_REF_KEY" },
			}),
			{ mode: 0o600 }
		);
		const { store, calls } = createFakeStore();

		const result = migratePlaintextApiKeys(authPath, store);

		// provider1 is oauth (skipped), provider2 already has env ref (no migration needed)
		expect(result.migratedProviders).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	test("handles corrupted auth file by recovering from backup", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, "not valid json", { mode: 0o600 });
		const { store } = createFakeStore();

		// Should not throw — readAuthData catches parse errors
		const result = migratePlaintextApiKeys(authPath, store);
		expect(result.migratedProviders).toEqual([]);
	});

	test("does not write file when no changes are needed", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const content = JSON.stringify(
			{ anthropic: { type: "api_key", key: "ANTHROPIC_API_KEY" } },
			null,
			2
		);
		writeFileSync(authPath, content, { mode: 0o600 });
		const { store } = createFakeStore();

		const result = migratePlaintextApiKeys(authPath, store);

		expect(result.migratedProviders).toEqual([]);
	});
});

describe("op:// reference conversion", () => {
	test("single-quotes the op:// reference in the command", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { store } = createFakeStore();

		persistProviderApiKey(authPath, "test", "op://Vault/Item With Spaces/field", store);

		const data = readAuth(authPath);
		expect(data.test.key).toBe("!opchain --read op read 'op://Vault/Item With Spaces/field'");
	});

	test("escapes single quotes within op:// reference", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { store } = createFakeStore();

		persistProviderApiKey(authPath, "test", "op://Vault/It's/field", store);

		const data = readAuth(authPath);
		// Shell escaping: ' → '\'' (close quote, escaped literal, reopen quote)
		expect(data.test.key).toContain("'op://Vault/It'\\''s/field'");
	});
});

describe("persistProviderApiKey return value", () => {
	test("returns 'keychain' for keychain command references", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const keychainStore: ApiKeySecretStore = {
			store: () => "!security find-generic-password -w -a 'tallow' -s 'tallow.api-key.test'",
		};

		const mode = persistProviderApiKey(authPath, "test", "raw-key", keychainStore);
		expect(mode).toBe("keychain");
	});

	test("returns 'reference' for non-keychain references", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const envStore: ApiKeySecretStore = {
			store: () => "!custom-secret-tool get test",
		};

		const mode = persistProviderApiKey(authPath, "test", "raw-key", envStore);
		expect(mode).toBe("reference");
	});

	test("returns 'reference' for env var references", () => {
		const dir = makeTempDir();
		const authPath = join(dir, "auth.json");
		const { store } = createFakeStore();

		const mode = persistProviderApiKey(authPath, "test", "MY_API_KEY", store);
		expect(mode).toBe("reference");
	});
});
