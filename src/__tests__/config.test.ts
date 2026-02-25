/**
 * Tests for src/config.ts — identity constants, path resolution, demo mode,
 * .env parsing, and bootstrap behavior.
 *
 * Tests that touch process.env save/restore original values in afterEach
 * to avoid cross-test contamination.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

// ─── Env snapshot helpers ────────────────────────────────────────────────────

/** Environment variables touched by tests — saved/restored per test. */
const ENV_KEYS = ["IS_DEMO", "TALLOW_DEMO", "USER", "USERNAME"] as const;

type EnvSnapshot = Record<string, string | undefined>;

/**
 * Capture current values for a set of env keys.
 *
 * @returns Snapshot of current env values
 */
function captureEnv(): EnvSnapshot {
	const snap: EnvSnapshot = {};
	for (const key of ENV_KEYS) {
		snap[key] = process.env[key];
	}
	return snap;
}

/**
 * Restore env to a previously captured snapshot.
 *
 * @param snap - Snapshot to restore
 */
function restoreEnv(snap: EnvSnapshot): void {
	for (const [key, value] of Object.entries(snap)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

// ─── Temp dir management ─────────────────────────────────────────────────────

// ─── Setup / Teardown ────────────────────────────────────────────────────────

let envSnap: EnvSnapshot;

beforeEach(() => {
	envSnap = captureEnv();
});

afterEach(() => {
	restoreEnv(envSnap);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("identity constants", () => {
	test("APP_NAME is tallow", async () => {
		const { APP_NAME } = await import("../config.js");
		expect(APP_NAME).toBe("tallow");
	});

	test("CONFIG_DIR is .tallow", async () => {
		const { CONFIG_DIR } = await import("../config.js");
		expect(CONFIG_DIR).toBe(".tallow");
	});

	test("TALLOW_VERSION matches semver pattern", async () => {
		const { TALLOW_VERSION } = await import("../config.js");
		expect(TALLOW_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});
});

describe("BUNDLED paths", () => {
	test("BUNDLED paths reference existing directories", async () => {
		const { BUNDLED } = await import("../config.js");
		expect(existsSync(BUNDLED.extensions)).toBe(true);
		expect(existsSync(BUNDLED.skills)).toBe(true);
		expect(existsSync(BUNDLED.themes)).toBe(true);
	});
});

describe("TEMPLATES paths", () => {
	test("TEMPLATES paths reference existing directories", async () => {
		const { TEMPLATES } = await import("../config.js");
		expect(existsSync(TEMPLATES.agents)).toBe(true);
		expect(existsSync(TEMPLATES.commands)).toBe(true);
	});
});

describe("isDemoMode", () => {
	test("returns false when no demo env vars are set", async () => {
		delete process.env.IS_DEMO;
		delete process.env.TALLOW_DEMO;
		const { isDemoMode } = await import("../config.js");
		expect(isDemoMode()).toBe(false);
	});

	test("returns true when IS_DEMO=1", async () => {
		process.env.IS_DEMO = "1";
		delete process.env.TALLOW_DEMO;
		const { isDemoMode } = await import("../config.js");
		expect(isDemoMode()).toBe(true);
	});

	test("returns true when TALLOW_DEMO=1", async () => {
		delete process.env.IS_DEMO;
		process.env.TALLOW_DEMO = "1";
		const { isDemoMode } = await import("../config.js");
		expect(isDemoMode()).toBe(true);
	});

	test("returns false when demo vars are set to non-1 values", async () => {
		process.env.IS_DEMO = "0";
		process.env.TALLOW_DEMO = "false";
		const { isDemoMode } = await import("../config.js");
		expect(isDemoMode()).toBe(false);
	});
});

describe("sanitizePath", () => {
	test("returns path unchanged when demo mode is off", async () => {
		delete process.env.IS_DEMO;
		delete process.env.TALLOW_DEMO;
		const { sanitizePath } = await import("../config.js");
		const path = "/Users/kevin/dev/tallow/src/config.ts";
		expect(sanitizePath(path)).toBe(path);
	});

	test("replaces username with demo when demo mode is active", async () => {
		process.env.IS_DEMO = "1";
		process.env.USER = "kevin";
		const { sanitizePath } = await import("../config.js");
		expect(sanitizePath("/Users/kevin/dev/tallow")).toBe("/Users/demo/dev/tallow");
	});

	test("replaces multiple username occurrences in a path", async () => {
		process.env.IS_DEMO = "1";
		process.env.USER = "kevin";
		const { sanitizePath } = await import("../config.js");
		expect(sanitizePath("/Users/kevin/dev/kevin/project")).toBe("/Users/demo/dev/demo/project");
	});

	test("returns path unchanged when USER is not set in demo mode", async () => {
		process.env.IS_DEMO = "1";
		delete process.env.USER;
		delete process.env.USERNAME;
		const { sanitizePath } = await import("../config.js");
		const path = "/Users/someone/dev";
		expect(sanitizePath(path)).toBe(path);
	});

	test("handles trailing username in path", async () => {
		process.env.IS_DEMO = "1";
		process.env.USER = "kevin";
		const { sanitizePath } = await import("../config.js");
		expect(sanitizePath("/home/kevin")).toBe("/home/demo");
	});

	test("falls back to USERNAME when USER is unset", async () => {
		process.env.IS_DEMO = "1";
		delete process.env.USER;
		process.env.USERNAME = "winuser";
		const { sanitizePath } = await import("../config.js");
		expect(sanitizePath("/Users/winuser/project")).toBe("/Users/demo/project");
	});
});

describe("getRuntimeTallowHome", () => {
	test("returns TALLOW_HOME when env override is not set", async () => {
		const { getRuntimeTallowHome, TALLOW_HOME } = await import("../config.js");
		const original = process.env.TALLOW_HOME;
		delete process.env.TALLOW_HOME;
		const result = getRuntimeTallowHome();
		// Restore
		if (original !== undefined) process.env.TALLOW_HOME = original;
		expect(result).toBe(TALLOW_HOME);
	});

	test("returns env override when TALLOW_HOME is set", async () => {
		const { getRuntimeTallowHome } = await import("../config.js");
		const original = process.env.TALLOW_HOME;
		process.env.TALLOW_HOME = "/tmp/override-home";
		const result = getRuntimeTallowHome();
		// Restore
		if (original !== undefined) {
			process.env.TALLOW_HOME = original;
		} else {
			delete process.env.TALLOW_HOME;
		}
		expect(result).toBe("/tmp/override-home");
	});
});

describe("getRuntimePathProvider / setRuntimePathProviderForTests", () => {
	test("returns default provider when no override is set", async () => {
		const { getRuntimePathProvider, setRuntimePathProviderForTests } = await import("../config.js");
		setRuntimePathProviderForTests(); // reset
		const provider = getRuntimePathProvider();
		expect(typeof provider.getHomeDir).toBe("function");
		expect(typeof provider.getRunDir).toBe("function");
	});

	test("returns override provider when set, and resets on undefined", async () => {
		const { getRuntimePathProvider, setRuntimePathProviderForTests } = await import("../config.js");
		const { createStaticRuntimePathProvider } = await import("../runtime-path-provider.js");

		const custom = createStaticRuntimePathProvider("/tmp/custom-home");
		setRuntimePathProviderForTests(custom);

		expect(getRuntimePathProvider().getHomeDir()).toBe("/tmp/custom-home");

		setRuntimePathProviderForTests(); // reset
		const defaultProvider = getRuntimePathProvider();
		expect(defaultProvider).not.toBe(custom);
	});
});

describe("bootstrap side effects", () => {
	test("sets process.title to tallow", async () => {
		const { bootstrap } = await import("../config.js");
		const originalTitle = process.title;
		bootstrap();
		expect(process.title).toBe("tallow");
		process.title = originalTitle;
	});
});

describe("env var module-scope exports", () => {
	test("PI_PACKAGE_DIR is set to PACKAGE_DIR", async () => {
		const { PACKAGE_DIR } = await import("../config.js");
		expect(process.env.PI_PACKAGE_DIR).toBe(PACKAGE_DIR);
	});

	test("PI_SKIP_VERSION_CHECK is 1", () => {
		expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
	});
});

describe("resolveOpSecrets", () => {
	test("no-ops when .env file does not exist", async () => {
		const { resolveOpSecrets } = await import("../config.js");
		// This should not throw even when TALLOW_HOME points to a non-existent dir.
		// The function catches the file-read error and returns early.
		await expect(resolveOpSecrets()).resolves.toBeUndefined();
	});
});
