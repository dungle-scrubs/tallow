import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ProjectTrustContext, ProjectTrustStatus } from "./project-trust.js";

export type { ProjectTrustStatus };

/** Event bus channels for the project-trust API handshake. */
export const PROJECT_TRUST_API_CHANNELS = {
	api: "interop.api.v1.project-trust.api",
	apiRequest: "interop.api.v1.project-trust.api-request",
} as const;

/** Cross-extension trust API used by cwd-changing flows. */
export interface ProjectTrustApi {
	/**
	 * Inspect the trust state for a candidate cwd.
	 *
	 * @param cwd - Working directory to inspect
	 * @returns Resolved trust context for the candidate cwd
	 */
	inspect(cwd: string): ProjectTrustContext;
	/**
	 * Persist trust for a candidate cwd.
	 *
	 * @param cwd - Working directory to trust
	 * @returns Updated trust context for the candidate cwd
	 */
	trust(cwd: string): ProjectTrustContext;
}

/**
 * Subscribe to the project-trust API with load-order-independent handshake.
 *
 * @param events - Shared extension event bus
 * @returns Getter for the latest published trust API, or null when unavailable
 */
export function subscribeToProjectTrustApi(
	events: ExtensionAPI["events"]
): () => ProjectTrustApi | null {
	let api: ProjectTrustApi | null = null;

	events.on(PROJECT_TRUST_API_CHANNELS.api, (data: unknown) => {
		const payload = data as { api?: ProjectTrustApi };
		if (
			payload?.api &&
			typeof payload.api.inspect === "function" &&
			typeof payload.api.trust === "function"
		) {
			api = payload.api;
		}
	});

	events.emit(PROJECT_TRUST_API_CHANNELS.apiRequest, {});
	return () => api;
}
