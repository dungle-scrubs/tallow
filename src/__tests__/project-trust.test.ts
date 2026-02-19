import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyProjectTrustContextToEnv,
	computeProjectFingerprint,
	getProjectTrustStatusFromEnv,
	resolveProjectTrust,
	trustProject,
	untrustProject,
} from "../project-trust.js";

let projectDir: string;
let trustDir: string;
let originalStoreOverride: string | undefined;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "tallow-trust-project-"));
	trustDir = mkdtempSync(join(tmpdir(), "tallow-trust-store-"));
	originalStoreOverride = process.env.TALLOW_PROJECT_TRUST_STORE_PATH;
	process.env.TALLOW_PROJECT_TRUST_STORE_PATH = join(trustDir, "projects.json");
});

afterEach(() => {
	if (originalStoreOverride !== undefined) {
		process.env.TALLOW_PROJECT_TRUST_STORE_PATH = originalStoreOverride;
	} else {
		delete process.env.TALLOW_PROJECT_TRUST_STORE_PATH;
	}

	rmSync(projectDir, { recursive: true, force: true });
	rmSync(trustDir, { recursive: true, force: true });
});

describe("project trust lifecycle", () => {
	test("starts untrusted when no trust entry exists", () => {
		const trust = resolveProjectTrust(projectDir);
		expect(trust.status).toBe("untrusted");
		expect(trust.storedFingerprint).toBeNull();
	});

	test("trustProject persists trust and resolve returns trusted", () => {
		const trusted = trustProject(projectDir);
		expect(trusted.status).toBe("trusted");

		const resolved = resolveProjectTrust(projectDir);
		expect(resolved.status).toBe("trusted");
		expect(resolved.storedFingerprint).toBe(resolved.fingerprint);
	});

	test("fingerprint changes invalidate trust", () => {
		trustProject(projectDir);
		mkdirSync(join(projectDir, ".tallow"), { recursive: true });
		writeFileSync(
			join(projectDir, ".tallow", "settings.json"),
			JSON.stringify({ shellInterpolation: true })
		);

		const stale = resolveProjectTrust(projectDir);
		expect(stale.status).toBe("stale_fingerprint");
		expect(stale.storedFingerprint).not.toBe(stale.fingerprint);
	});

	test("untrustProject removes persisted trust", () => {
		trustProject(projectDir);
		const removed = untrustProject(projectDir);
		expect(removed.status).toBe("untrusted");

		const resolved = resolveProjectTrust(projectDir);
		expect(resolved.status).toBe("untrusted");
	});

	test("corrupt trust store fails closed", () => {
		writeFileSync(join(trustDir, "projects.json"), "{ not-json");
		const resolved = resolveProjectTrust(projectDir);
		expect(resolved.status).toBe("untrusted");
	});
});

describe("fingerprint scope", () => {
	test("includes trust-scoped settings keys", () => {
		mkdirSync(join(projectDir, ".tallow"), { recursive: true });
		writeFileSync(
			join(projectDir, ".tallow", "settings.json"),
			JSON.stringify({ shellInterpolation: false })
		);
		const a = computeProjectFingerprint(projectDir);

		writeFileSync(
			join(projectDir, ".tallow", "settings.json"),
			JSON.stringify({ shellInterpolation: true })
		);
		const b = computeProjectFingerprint(projectDir);
		expect(a).not.toBe(b);
	});

	test("ignores non-trust-scoped settings keys", () => {
		mkdirSync(join(projectDir, ".tallow"), { recursive: true });
		writeFileSync(
			join(projectDir, ".tallow", "settings.json"),
			JSON.stringify({ randomThemeOnStart: true })
		);
		const a = computeProjectFingerprint(projectDir);

		writeFileSync(
			join(projectDir, ".tallow", "settings.json"),
			JSON.stringify({ randomThemeOnStart: false })
		);
		const b = computeProjectFingerprint(projectDir);
		expect(a).toBe(b);
	});
});

describe("trust env projection", () => {
	test("applies trust context to env", () => {
		const trust = trustProject(projectDir);
		applyProjectTrustContextToEnv(trust);
		expect(getProjectTrustStatusFromEnv()).toBe("trusted");
	});
});
