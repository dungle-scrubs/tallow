import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyProjectTrustContextToEnv,
	computeProjectFingerprint,
	getCanonicalCwd,
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

/**
 * Read the persisted trust store fixture from disk.
 *
 * @returns Parsed trust store JSON
 */
function readPersistedTrustStore(): Record<string, Record<string, unknown>> {
	return JSON.parse(readFileSync(join(trustDir, "projects.json"), "utf-8")) as Record<
		string,
		Record<string, unknown>
	>;
}

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

		const persistedStore = readPersistedTrustStore();
		expect(persistedStore[getCanonicalCwd(projectDir)]).toEqual({
			fingerprint: resolved.fingerprint,
			trustedAt: expect.any(String),
			version: expect.any(Number),
		});
	});

	test("migrates legacy trusted entries instead of marking them stale", () => {
		const trustedAt = "2026-03-09T03:13:00.000Z";
		const canonicalProjectDir = getCanonicalCwd(projectDir);
		writeFileSync(
			join(trustDir, "projects.json"),
			JSON.stringify(
				{
					[canonicalProjectDir]: {
						fingerprint: "legacy-fingerprint",
						trustedAt,
					},
				},
				null,
				"\t"
			)
		);

		const resolved = resolveProjectTrust(projectDir);
		expect(resolved.status).toBe("trusted");
		expect(resolved.storedFingerprint).toBe(resolved.fingerprint);

		const persistedStore = readPersistedTrustStore();
		expect(persistedStore[canonicalProjectDir]).toEqual({
			fingerprint: resolved.fingerprint,
			trustedAt,
			version: expect.any(Number),
		});
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

	test("includes trusted Claude compatibility settings", () => {
		mkdirSync(join(projectDir, ".claude"), { recursive: true });
		writeFileSync(
			join(projectDir, ".claude", "settings.json"),
			JSON.stringify({ permissions: { deny: ["Bash(ssh *)"] } })
		);
		const a = computeProjectFingerprint(projectDir);

		writeFileSync(
			join(projectDir, ".claude", "settings.json"),
			JSON.stringify({ permissions: { deny: ["Bash(curl *)"] } })
		);
		const b = computeProjectFingerprint(projectDir);
		expect(a).not.toBe(b);
	});

	test("includes trusted project agent directories", () => {
		mkdirSync(join(projectDir, ".tallow", "agents"), { recursive: true });
		writeFileSync(
			join(projectDir, ".tallow", "agents", "reviewer.md"),
			"---\nname: reviewer\ndescription: review code\n---\nReview carefully.\n"
		);
		const a = computeProjectFingerprint(projectDir);

		writeFileSync(
			join(projectDir, ".tallow", "agents", "reviewer.md"),
			"---\nname: reviewer\ndescription: review code\n---\nReview aggressively.\n"
		);
		const b = computeProjectFingerprint(projectDir);
		expect(a).not.toBe(b);
	});

	test("includes trusted project prompts and rules", () => {
		mkdirSync(join(projectDir, ".tallow", "prompts"), { recursive: true });
		mkdirSync(join(projectDir, ".tallow", "rules"), { recursive: true });
		writeFileSync(join(projectDir, ".tallow", "prompts", "review.md"), "Prompt v1\n");
		writeFileSync(join(projectDir, ".tallow", "rules", "rule.md"), "Rule v1\n");
		const a = computeProjectFingerprint(projectDir);

		writeFileSync(join(projectDir, ".tallow", "prompts", "review.md"), "Prompt v2\n");
		writeFileSync(join(projectDir, ".tallow", "rules", "rule.md"), "Rule v2\n");
		const b = computeProjectFingerprint(projectDir);
		expect(a).not.toBe(b);
	});
});

describe("trust env projection", () => {
	test("applies trust context to env", () => {
		const trust = trustProject(projectDir);
		applyProjectTrustContextToEnv(trust);
		expect(getProjectTrustStatusFromEnv()).toBe("trusted");
	});
});
