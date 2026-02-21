import type { ProjectTrustContext, ProjectTrustStatus } from "./project-trust.js";

/** Structured payload for rendering trust warnings in UI + message stream. */
export interface ProjectTrustBannerPayload {
	readonly content: string;
	readonly details: {
		readonly canonicalCwd: string;
		readonly fingerprint: string;
		readonly status: ProjectTrustStatus;
	};
}

/**
 * Wrap multiline text in a simple box so high-signal warnings stand out in the UI.
 *
 * @param lines - Lines to render inside the box
 * @returns Boxed message string
 */
export function formatMessageBox(lines: readonly string[]): string {
	const safeLines = lines.length > 0 ? lines : [""];
	const width = safeLines.reduce((max, line) => Math.max(max, line.length), 0);
	const border = "─".repeat(width + 2);

	return [
		`┌${border}┐`,
		...safeLines.map((line) => `│ ${line.padEnd(width, " ")} │`),
		`└${border}┘`,
	].join("\n");
}

/**
 * Build a trust warning banner shown when repo-controlled surfaces are blocked.
 *
 * @param trust - Current project trust context
 * @returns Human-readable trust warning message
 */
export function formatProjectTrustBanner(trust: ProjectTrustContext): string {
	const statusLine =
		trust.status === "stale_fingerprint"
			? "Trust is stale: trust-scoped config changed since last approval."
			: "This project is currently untrusted.";

	return formatMessageBox([
		"PROJECT TRUST REQUIRED",
		"",
		statusLine,
		"",
		"Blocked until trusted:",
		"  plugins, hooks, mcpServers, packages, permissions, shellInterpolation,",
		"  and project extensions.",
		"",
		"Trusting this folder means trusting the code and config inside it.",
		"Those files can change agent behavior and execute commands.",
		"",
		"Use /trust-project to enable these surfaces for this folder.",
		"Use /trust-status to inspect trust state or /untrust-project to revoke.",
		"Trust auto-invalidates when trust-scoped project config changes.",
	]);
}

/**
 * Build a project-trust banner payload for both UI notifications and session messages.
 *
 * @param trust - Current project trust context
 * @returns Payload with preformatted content and trust details
 */
export function buildProjectTrustBannerPayload(
	trust: ProjectTrustContext
): ProjectTrustBannerPayload {
	return {
		content: formatProjectTrustBanner(trust),
		details: {
			canonicalCwd: trust.canonicalCwd,
			fingerprint: trust.fingerprint,
			status: trust.status,
		},
	};
}
