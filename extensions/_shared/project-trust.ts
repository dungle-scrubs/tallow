/**
 * Project trust helpers shared by extensions.
 *
 * Extensions cannot reliably import core src modules at runtime, so trust
 * status is projected into process env by sdk.ts. These helpers provide a
 * typed, fail-closed view of that env state.
 */

/** Trust statuses emitted by the core trust resolver. */
export type ProjectTrustStatus = "trusted" | "untrusted" | "stale_fingerprint";

/** Environment key for project trust status. */
const PROJECT_TRUST_STATUS_ENV = "TALLOW_PROJECT_TRUST_STATUS";

/**
 * Read project trust status from environment.
 *
 * Unknown or missing values fail closed to `untrusted`.
 *
 * @returns Current project trust status for this process
 */
export function getProjectTrustStatus(): ProjectTrustStatus {
	const raw = process.env[PROJECT_TRUST_STATUS_ENV];
	if (raw === "trusted" || raw === "untrusted" || raw === "stale_fingerprint") {
		return raw;
	}
	return "untrusted";
}

/** Shared trust decision for loading project-scoped settings. */
export interface ProjectSettingsTrustDecision {
	readonly allowProjectSettings: boolean;
	readonly trustStatus: ProjectTrustStatus;
}

/**
 * Resolve whether project-scoped settings should be honored.
 *
 * @returns Trust decision with status and project-settings gate
 */
export function getProjectSettingsTrustDecision(): ProjectSettingsTrustDecision {
	const trustStatus = getProjectTrustStatus();
	return {
		allowProjectSettings: trustStatus === "trusted",
		trustStatus,
	};
}

/**
 * Check whether repo-controlled project surfaces should be allowed.
 *
 * @returns True only when trust status is `trusted`
 */
export function isProjectTrusted(): boolean {
	return getProjectSettingsTrustDecision().allowProjectSettings;
}

/**
 * Check whether project surfaces are blocked due to trust state.
 *
 * @returns True when project trust is not `trusted`
 */
export function isProjectTrustBlocked(): boolean {
	return !isProjectTrusted();
}
