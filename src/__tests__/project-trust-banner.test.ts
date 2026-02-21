import { describe, expect, test } from "bun:test";
import type { ProjectTrustContext } from "../project-trust.js";
import {
	buildProjectTrustBannerPayload,
	formatMessageBox,
	formatProjectTrustBanner,
} from "../project-trust-banner.js";

/**
 * Creates a trust context for banner-format tests.
 *
 * @param status - Trust status to use in the context
 * @returns Trust context fixture
 */
function makeTrustContext(status: ProjectTrustContext["status"]): ProjectTrustContext {
	return {
		canonicalCwd: "/tmp/project",
		fingerprint: "fingerprint-123",
		status,
		storedFingerprint: status === "untrusted" ? null : "fingerprint-old",
	};
}

describe("formatMessageBox", () => {
	test("renders a box sized to the widest line", () => {
		const box = formatMessageBox(["a", "bb"]);
		expect(box.split("\n")).toEqual(["┌────┐", "│ a  │", "│ bb │", "└────┘"]);
	});

	test("renders a minimal box when no lines are provided", () => {
		const box = formatMessageBox([]);
		expect(box.split("\n")).toEqual(["┌──┐", "│  │", "└──┘"]);
	});
});

describe("formatProjectTrustBanner", () => {
	test("includes explicit untrusted risk language inside a box", () => {
		const banner = formatProjectTrustBanner(makeTrustContext("untrusted"));

		expect(banner).toContain("┌");
		expect(banner).toContain("└");
		expect(banner).toContain("PROJECT TRUST REQUIRED");
		expect(banner).toContain("This project is currently untrusted.");
		expect(banner).toContain("Trusting this folder means trusting the code and config inside it.");
		expect(banner).toContain("Use /trust-project to enable these surfaces for this folder.");
	});

	test("uses stale-fingerprint language when trust is stale", () => {
		const banner = formatProjectTrustBanner(makeTrustContext("stale_fingerprint"));

		expect(banner).toContain("Trust is stale: trust-scoped config changed since last approval.");
		expect(banner).not.toContain("This project is currently untrusted.");
	});
});

describe("buildProjectTrustBannerPayload", () => {
	test("returns matching content + details for notify and custom message paths", () => {
		const trust = makeTrustContext("stale_fingerprint");
		const payload = buildProjectTrustBannerPayload(trust);

		expect(payload.content).toBe(formatProjectTrustBanner(trust));
		expect(payload.details).toEqual({
			canonicalCwd: trust.canonicalCwd,
			fingerprint: trust.fingerprint,
			status: trust.status,
		});
	});
});
