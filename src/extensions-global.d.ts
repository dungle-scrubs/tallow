/**
 * Global type declarations for tallow extensions.
 *
 * These globals are for extension-local cross-reload persistence only.
 * Cross-extension communication must use typed `pi.events` contracts.
 */

declare global {
	// subagent-tool extension (cross-reload interval cleanup)
	var __piSubagentWidgetInterval: ReturnType<typeof setInterval> | null | undefined;

	// git-status extension
	var __piGitStatusInterval: ReturnType<typeof setInterval> | null | undefined;

	// session-memory extension
	var __piSessionIndexer: unknown | undefined;

	// debug extension
	var __piDebugLogger:
		| {
				readonly sessionId: string;
				readonly logPath: string;
				log(cat: string, evt: string, data: Record<string, unknown>): void;
				clear(): void;
				close(): void;
		  }
		| undefined;

	// shell-policy shared module (audit trail persists across extension reloads)
	var __piShellAuditTrail:
		| Array<{
				readonly timestamp: number;
				readonly command: string;
				readonly source: string;
				readonly trustLevel: "explicit" | "implicit" | "internal";
				readonly cwd: string;
				readonly outcome: "allowed" | "blocked" | "confirmed" | "bypassed" | "executed" | "failed";
				readonly reason?: string;
				readonly exitCode?: number | null;
				readonly durationMs?: number;
		  }>
		| undefined;
}

export {};
