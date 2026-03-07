import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectTrustStatus, isProjectTrusted } from "../project-trust.js";

let trustedCwd = "";
let otherCwd = "";
let originalTrustCwd: string | undefined;
let originalTrustStatus: string | undefined;

beforeEach(() => {
	trustedCwd = mkdtempSync(join(tmpdir(), "shared-project-trust-a-"));
	otherCwd = mkdtempSync(join(tmpdir(), "shared-project-trust-b-"));
	originalTrustCwd = process.env.TALLOW_PROJECT_TRUST_CWD;
	originalTrustStatus = process.env.TALLOW_PROJECT_TRUST_STATUS;
	process.env.TALLOW_PROJECT_TRUST_CWD = trustedCwd;
	process.env.TALLOW_PROJECT_TRUST_STATUS = "trusted";
});

afterEach(() => {
	if (originalTrustCwd === undefined) {
		delete process.env.TALLOW_PROJECT_TRUST_CWD;
	} else {
		process.env.TALLOW_PROJECT_TRUST_CWD = originalTrustCwd;
	}
	if (originalTrustStatus === undefined) {
		delete process.env.TALLOW_PROJECT_TRUST_STATUS;
	} else {
		process.env.TALLOW_PROJECT_TRUST_STATUS = originalTrustStatus;
	}
	rmSync(trustedCwd, { force: true, recursive: true });
	rmSync(otherCwd, { force: true, recursive: true });
});

describe("shared project trust helpers", () => {
	it("accepts trust only for the matching cwd", () => {
		expect(getProjectTrustStatus(trustedCwd)).toBe("trusted");
		expect(isProjectTrusted(trustedCwd)).toBe(true);
	});

	it("fails closed when the cwd differs from the projected trust context", () => {
		expect(getProjectTrustStatus(otherCwd)).toBe("untrusted");
		expect(isProjectTrusted(otherCwd)).toBe(false);
	});

	it("fails closed for missing trust cwd metadata", () => {
		delete process.env.TALLOW_PROJECT_TRUST_CWD;
		expect(getProjectTrustStatus(trustedCwd)).toBe("untrusted");
	});
});
