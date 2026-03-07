/**
 * Project trust helpers shared by extensions.
 *
 * Extensions cannot reliably import core src modules at runtime, so trust
 * status is projected into process env by sdk.ts. These helpers provide a
 * typed, fail-closed view of that env state.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Trust statuses emitted by the core trust resolver. */
export type ProjectTrustStatus = "trusted" | "untrusted" | "stale_fingerprint";

/** Environment key for project trust status. */
const PROJECT_TRUST_STATUS_ENV = "TALLOW_PROJECT_TRUST_STATUS";
/** Environment key for canonical cwd associated with the trust context. */
const PROJECT_TRUST_CWD_ENV = "TALLOW_PROJECT_TRUST_CWD";

/**
 * Resolve a cwd to the same canonical form used by the core trust store.
 *
 * @param cwd - Working directory to canonicalize
 * @returns Canonical absolute path, or resolved path on failure
 */
function getCanonicalCwd(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return resolve(cwd);
	}
}

/**
 * Return whether the env-projected trust context still matches the target cwd.
 *
 * Trust must fail closed when the process cwd changes without the env context
 * being refreshed yet.
 *
 * @param cwd - Working directory to validate against the env-projected trust context
 * @returns True when the env trust context belongs to the same canonical cwd
 */
function isTrustContextCurrent(cwd: string): boolean {
	const envCwd = process.env[PROJECT_TRUST_CWD_ENV];
	if (!envCwd) return false;
	return getCanonicalCwd(cwd) === getCanonicalCwd(envCwd);
}

/**
 * Read project trust status from environment.
 *
 * Unknown or missing values fail closed to `untrusted`. When the projected
 * trust context belongs to a different cwd than the current request, the
 * result also fails closed to `untrusted`.
 *
 * @param cwd - Working directory that wants to use the trust context
 * @returns Current project trust status for this process and cwd
 */
export function getProjectTrustStatus(cwd: string = process.cwd()): ProjectTrustStatus {
	const raw = process.env[PROJECT_TRUST_STATUS_ENV];
	if (raw !== "trusted" && raw !== "untrusted" && raw !== "stale_fingerprint") {
		return "untrusted";
	}
	if (!isTrustContextCurrent(cwd)) {
		return "untrusted";
	}
	return raw;
}

/** Shared trust decision for loading project-scoped settings. */
export interface ProjectSettingsTrustDecision {
	readonly allowProjectSettings: boolean;
	readonly trustStatus: ProjectTrustStatus;
}

/**
 * Resolve whether project-scoped settings should be honored.
 *
 * @param cwd - Working directory that wants to load project-scoped settings
 * @returns Trust decision with status and project-settings gate
 */
export function getProjectSettingsTrustDecision(
	cwd: string = process.cwd()
): ProjectSettingsTrustDecision {
	const trustStatus = getProjectTrustStatus(cwd);
	return {
		allowProjectSettings: trustStatus === "trusted",
		trustStatus,
	};
}

/**
 * Check whether repo-controlled project surfaces should be allowed.
 *
 * @param cwd - Working directory that wants to use project-controlled surfaces
 * @returns True only when trust status is `trusted`
 */
export function isProjectTrusted(cwd: string = process.cwd()): boolean {
	return getProjectSettingsTrustDecision(cwd).allowProjectSettings;
}

/**
 * Check whether project surfaces are blocked due to trust state.
 *
 * @param cwd - Working directory that wants to use project-controlled surfaces
 * @returns True when project trust is not `trusted`
 */
export function isProjectTrustBlocked(cwd: string = process.cwd()): boolean {
	return !isProjectTrusted(cwd);
}
