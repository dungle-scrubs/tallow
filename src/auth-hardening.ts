import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { dirname } from "node:path";
import {
	type ApiKeyCredential,
	type AuthCredential,
	AuthStorage,
	type AuthStorageBackend,
	FileAuthStorageBackend,
} from "@mariozechner/pi-coding-agent";
import { atomicWriteFileSync, restoreFromBackup } from "./atomic-write.js";

const AUTH_FILE_MODE = 0o600;
const AUTH_DIRECTORY_MODE = 0o700;
const KEYCHAIN_ACCOUNT = "tallow";
const KEYCHAIN_SERVICE_PREFIX = "tallow.api-key";
const ENV_REFERENCE_PATTERN = /^[A-Z][A-Z0-9]*_[A-Z0-9_]*$/;

/** Result of the plaintext migration run. */
export interface MigrationResult {
	/** Providers migrated from plaintext/op:// to secure references. */
	readonly migratedProviders: readonly string[];
}

/** Storage outcome for persisted provider credentials. */
export type PersistedKeyMode = "keychain" | "reference";

/**
 * Dependency boundary for storing raw API keys outside auth.json.
 */
export interface ApiKeySecretStore {
	/**
	 * Store a raw API key and return a safe reference string for auth.json.
	 *
	 * @param provider - Provider ID
	 * @param apiKey - Raw provider API key
	 * @returns Reference string to persist in auth.json
	 */
	store(provider: string, apiKey: string): string;
}

export interface SecureAuthStorageOptions {
	readonly secretStore?: ApiKeySecretStore;
}

/** Return value from {@link createSecureAuthStorage}. */
export interface SecureAuthStorageResult {
	/** AuthStorage instance with secure persistence. */
	readonly authStorage: AuthStorage;
	/** Providers migrated from plaintext to secure references on creation. */
	readonly migration: MigrationResult;
}

/**
 * AuthStorageBackend that intercepts writes to normalize API key credentials.
 * Wraps FileAuthStorageBackend — raw keys are converted to secure references
 * (keychain/opchain/env/shell) before they reach disk.
 */
class SecureFileAuthStorageBackend implements AuthStorageBackend {
	private readonly inner: FileAuthStorageBackend;
	private readonly secretStore: ApiKeySecretStore;

	/**
	 * @param authPath - Absolute auth.json path
	 * @param secretStore - Backend for raw key storage
	 */
	constructor(authPath: string, secretStore: ApiKeySecretStore) {
		this.inner = new FileAuthStorageBackend(authPath);
		this.secretStore = secretStore;
	}

	/**
	 * Execute fn under lock, normalizing any API keys in the write payload.
	 *
	 * @param fn - Lock callback receiving current content
	 * @returns Result from fn
	 */
	withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
		return this.inner.withLock((current) => {
			const lockResult = fn(current);
			if (lockResult.next !== undefined) {
				lockResult.next = this.normalizeStorageContent(lockResult.next);
			}
			return lockResult;
		});
	}

	/**
	 * Async variant of withLock.
	 *
	 * @param fn - Async lock callback receiving current content
	 * @returns Result from fn
	 */
	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<{ result: T; next?: string }>
	): Promise<T> {
		return this.inner.withLockAsync(async (current) => {
			const lockResult = await fn(current);
			if (lockResult.next !== undefined) {
				lockResult.next = this.normalizeStorageContent(lockResult.next);
			}
			return lockResult;
		});
	}

	/**
	 * Parse JSON content and normalize any raw API keys to secure references.
	 *
	 * @param jsonContent - Serialized auth data
	 * @returns Normalized JSON content
	 */
	private normalizeStorageContent(jsonContent: string): string {
		try {
			const data = JSON.parse(jsonContent) as Record<string, AuthCredential>;
			let changed = false;
			for (const [provider, credential] of Object.entries(data)) {
				if (credential?.type !== "api_key" || typeof credential.key !== "string") continue;
				const normalized = normalizeApiKeyValue(provider, credential.key, this.secretStore);
				if (normalized !== credential.key) {
					(data[provider] as ApiKeyCredential).key = normalized;
					changed = true;
				}
			}
			return changed ? JSON.stringify(data, null, 2) : jsonContent;
		} catch {
			return jsonContent;
		}
	}
}

/**
 * Create an AuthStorage instance with secure persistence.
 * Raw API keys are normalized to references at the storage-backend layer,
 * ensuring they never reach disk in plaintext. Runs one-time migration
 * for any existing plaintext keys.
 *
 * @param authPath - Absolute auth.json path
 * @param options - Optional testing dependencies
 * @returns AuthStorage instance and migration result
 */
export function createSecureAuthStorage(
	authPath: string,
	options: SecureAuthStorageOptions = {}
): SecureAuthStorageResult {
	const secretStore = options.secretStore ?? createApiKeySecretStore();

	assertSecureAuthFilePermissions(authPath);
	const migration = migratePlaintextApiKeys(authPath, secretStore);

	const backend = new SecureFileAuthStorageBackend(authPath, secretStore);
	const authStorage = AuthStorage.fromStorage(backend);

	return { authStorage, migration };
}

/**
 * Fail when auth.json permissions are insecure.
 *
 * @param authPath - Absolute auth.json path
 * @returns void
 * @throws {Error} When mode is not 0600 on non-Windows platforms
 */
export function assertSecureAuthFilePermissions(authPath: string): void {
	if (platform() === "win32") return;
	if (!existsSync(authPath)) return;

	const mode = statSync(authPath).mode & 0o777;
	if (mode !== AUTH_FILE_MODE) {
		throw new Error(
			`Insecure auth file permissions for ${authPath}: expected 0600, got 0${mode.toString(8)}.`
		);
	}
}

/**
 * Persist a provider API key input (raw key or reference) into auth.json.
 *
 * @param authPath - Absolute auth.json path
 * @param provider - Provider ID
 * @param apiKeyInput - Raw key or secure reference string
 * @param secretStore - Optional storage backend for raw keys
 * @returns How the key was persisted (keychain or reference)
 */
export function persistProviderApiKey(
	authPath: string,
	provider: string,
	apiKeyInput: string,
	secretStore: ApiKeySecretStore = createApiKeySecretStore()
): PersistedKeyMode {
	const data = readAuthData(authPath);
	const normalizedKey = normalizeApiKeyValue(provider, apiKeyInput, secretStore);
	data[provider] = { type: "api_key", key: normalizedKey };
	writeAuthData(authPath, data);
	return isKeychainCommandReference(normalizedKey) ? "keychain" : "reference";
}

/**
 * One-time migration from plaintext keys to secure references.
 *
 * @param authPath - Absolute auth.json path
 * @param secretStore - Optional storage backend for raw keys
 * @returns Providers whose key entries changed
 */
export function migratePlaintextApiKeys(
	authPath: string,
	secretStore: ApiKeySecretStore = createApiKeySecretStore()
): MigrationResult {
	if (!existsSync(authPath)) {
		return { migratedProviders: [] };
	}

	const data = readAuthData(authPath);
	const migratedProviders: string[] = [];
	let changed = false;

	for (const [provider, credential] of Object.entries(data)) {
		if (!credential || credential.type !== "api_key") continue;
		if (typeof credential.key !== "string") continue;

		const normalizedKey = normalizeApiKeyValue(provider, credential.key, secretStore);
		if (normalizedKey === credential.key) continue;

		data[provider] = { type: "api_key", key: normalizedKey };
		migratedProviders.push(provider);
		changed = true;
	}

	if (changed) {
		writeAuthData(authPath, data);
	}

	return { migratedProviders };
}

/**
 * Resolve runtime API key overrides from environment variables.
 *
 * Supported inputs:
 * - TALLOW_API_KEY (raw key)
 * - TALLOW_API_KEY_REF (op:// ref, !command ref, or ENV_VAR_NAME)
 *
 * @returns Resolved runtime API key if present
 * @throws {Error} When both TALLOW_API_KEY and TALLOW_API_KEY_REF are set
 */
export function resolveRuntimeApiKeyFromEnv(): string | undefined {
	const runtimeKey = process.env.TALLOW_API_KEY;
	const runtimeRef = process.env.TALLOW_API_KEY_REF;

	if (runtimeKey && runtimeRef) {
		throw new Error("Set either TALLOW_API_KEY or TALLOW_API_KEY_REF, not both.");
	}
	if (runtimeKey) return runtimeKey;
	if (!runtimeRef) return undefined;
	return resolveReferenceValue(runtimeRef);
}

/**
 * Create an API key secret store for the current platform.
 *
 * @returns Platform-specific secret store
 */
function createApiKeySecretStore(): ApiKeySecretStore {
	if (platform() === "darwin") {
		return new MacOsKeychainStore();
	}
	return new UnsupportedSecretStore();
}

/**
 * Normalize any API key input into a safe persisted reference.
 *
 * @param provider - Provider ID
 * @param value - Raw key or reference
 * @param secretStore - Backend for raw key storage
 * @returns Safe value to persist in auth.json
 */
function normalizeApiKeyValue(
	provider: string,
	value: string,
	secretStore: ApiKeySecretStore
): string {
	const trimmedValue = value.trim();
	if (!trimmedValue) {
		throw new Error(`Empty API key value for provider "${provider}".`);
	}

	if (trimmedValue.startsWith("!")) return trimmedValue;
	if (trimmedValue.startsWith("op://")) return toOpchainCommandReference(trimmedValue);
	if (ENV_REFERENCE_PATTERN.test(trimmedValue)) return trimmedValue;

	return secretStore.store(provider, trimmedValue);
}

/**
 * Read auth.json as provider → credential map.
 *
 * @param authPath - Absolute auth.json path
 * @returns Parsed auth data or empty object
 */
function readAuthData(authPath: string): Record<string, AuthCredential> {
	if (!existsSync(authPath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, AuthCredential>;
		if (parsed && typeof parsed === "object") {
			return parsed;
		}
		return {};
	} catch {
		// Primary file is corrupt — attempt backup recovery
		const restored = restoreFromBackup(authPath, (content) => {
			JSON.parse(content);
		});
		if (restored) {
			console.error("auth: restored auth.json from backup after corruption");
			try {
				return JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, AuthCredential>;
			} catch {
				return {};
			}
		}
		return {};
	}
}

/**
 * Write auth.json with enforced permissions.
 *
 * @param authPath - Absolute auth.json path
 * @param data - Credential map to persist
 * @returns void
 */
function writeAuthData(authPath: string, data: Record<string, AuthCredential>): void {
	const dir = dirname(authPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: AUTH_DIRECTORY_MODE });
	}
	atomicWriteFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`, {
		fsync: true,
		mode: AUTH_FILE_MODE,
		backup: true,
	});
}

/**
 * Resolve a reference string to its key value.
 *
 * @param reference - Reference value from TALLOW_API_KEY_REF
 * @returns Resolved key value
 */
function resolveReferenceValue(reference: string): string {
	if (reference.startsWith("op://")) {
		return runOpchainRead(reference);
	}
	if (reference.startsWith("!")) {
		return runShellCommand(reference.slice(1));
	}
	if (ENV_REFERENCE_PATTERN.test(reference)) {
		const envValue = process.env[reference];
		if (!envValue) {
			throw new Error(`Environment variable reference is not set: ${reference}`);
		}
		return envValue;
	}
	return reference;
}

/**
 * Execute a shell command reference from user config.
 *
 * This is an intentional feature: users configure API key resolution via
 * `!command` references in their settings (e.g., `!pass show api-key`).
 * The command is always user-authored config, never agent or network input.
 *
 * @param command - Shell command without leading `!`
 * @returns Trimmed stdout
 */
function runShellCommand(command: string): string {
	// Guard: reject null bytes and excessively long commands
	if (command.includes("\0")) {
		throw new Error("Shell command reference contains null bytes.");
	}
	if (command.length > 1024) {
		throw new Error("Shell command reference exceeds 1024 character limit.");
	}

	// Reject shell metacharacters that could alter command semantics.
	// Allowed: alphanumeric, whitespace, and common path/flag chars (-_./:"'=~@,+).
	// Users needing pipes/subshells/expansion can wrap logic in a script file.
	if (/[^a-zA-Z0-9\s\-_./"'=:~@,+\\]/.test(command)) {
		throw new Error(
			"Shell command reference contains disallowed characters. " +
				"Only alphanumeric characters, spaces, and common path/flag characters " +
				"(-_./\"'=:~@,+\\) are permitted. For complex commands, use a wrapper script."
		);
	}

	// Intentional: `!command` references in user-authored config (e.g., `!pass show api-key`).
	// The command string originates from the user's local settings file, never from agent
	// or network input. This is a core feature for secret-manager integration.
	const output = execFileSync("sh", ["-c", command], {
		encoding: "utf-8",
		timeout: 10_000,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const value = output.trim();
	if (!value) {
		throw new Error("Runtime API key reference command returned an empty value.");
	}
	return value;
}

/**
 * Resolve an op:// reference via opchain.
 *
 * @param reference - 1Password reference
 * @returns Resolved secret value
 */
function runOpchainRead(reference: string): string {
	const output = execFileSync("opchain", ["--read", "op", "read", reference], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const value = output.trim();
	if (!value) {
		throw new Error(`opchain returned an empty value for ${reference}.`);
	}
	return value;
}

/**
 * Convert an op:// reference to a shell command reference.
 *
 * @param reference - 1Password reference
 * @returns Shell command reference for resolveConfigValue()
 */
function toOpchainCommandReference(reference: string): string {
	return `!opchain --read op read ${quoteForShell(reference)}`;
}

/**
 * Quote a value for safe single-quoted shell usage.
 *
 * @param value - Raw string
 * @returns Shell-safe single-quoted string
 */
function quoteForShell(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Check whether a command reference points to keychain retrieval.
 *
 * @param value - Persisted key reference value
 * @returns true when value is a security find-generic-password command ref
 */
function isKeychainCommandReference(value: string): boolean {
	return value.startsWith("!security find-generic-password ");
}

/**
 * macOS keychain-backed secret store.
 */
class MacOsKeychainStore implements ApiKeySecretStore {
	/**
	 * Store a key in macOS keychain and return a command ref.
	 *
	 * @param provider - Provider ID
	 * @param apiKey - Raw API key
	 * @returns Command ref that resolves keychain value
	 */
	store(provider: string, apiKey: string): string {
		const service = `${KEYCHAIN_SERVICE_PREFIX}.${provider}`;
		execFileSync(
			"security",
			["add-generic-password", "-U", "-a", KEYCHAIN_ACCOUNT, "-s", service, "-w", apiKey],
			{ stdio: "ignore" }
		);

		const readBack = execFileSync(
			"security",
			["find-generic-password", "-w", "-a", KEYCHAIN_ACCOUNT, "-s", service],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
		).trim();

		if (readBack !== apiKey) {
			throw new Error(`Keychain verification failed for provider "${provider}".`);
		}

		return [
			"!security find-generic-password -w",
			`-a ${quoteForShell(KEYCHAIN_ACCOUNT)}`,
			`-s ${quoteForShell(service)}`,
		].join(" ");
	}
}

/**
 * Secret store used on platforms without built-in keychain integration.
 */
class UnsupportedSecretStore implements ApiKeySecretStore {
	/**
	 * Reject raw key persistence when no keychain backend is available.
	 *
	 * @param provider - Provider ID
	 * @param _apiKey - Raw API key
	 * @throws {Error} Always throws
	 */
	store(provider: string, _apiKey: string): string {
		throw new Error(
			`Raw API key persistence is disabled for provider "${provider}" on ${platform()}. ` +
				"Use an op:// reference, a !command reference, or an ENV_VAR_NAME in auth.json."
		);
	}
}
