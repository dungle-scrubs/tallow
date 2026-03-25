/**
 * Tests for buildWorkspaceTransitionSummary — the synthetic context
 * shown to the model after a workspace transition.
 */
import { describe, expect, it } from "bun:test";
import { buildWorkspaceTransitionSummary } from "../workspace-transition.js";

describe("buildWorkspaceTransitionSummary", () => {
	it("produces a generic message without task context", () => {
		const summary = buildWorkspaceTransitionSummary("/a", "/b", "tool", true);

		expect(summary).toContain("Workspace transition complete (tool request)");
		expect(summary).toContain("Previous workspace: /a");
		expect(summary).toContain("Current workspace: /b");
		expect(summary).toContain("Treat the interrupted turn as ended");
		expect(summary).not.toContain("Task context");
	});

	it("includes task context when provided", () => {
		const summary = buildWorkspaceTransitionSummary("/a", "/b", "tool", true, "fix the auth bug");

		expect(summary).toContain("Task context carried forward");
		expect(summary).toContain("fix the auth bug");
		expect(summary).toContain("Continue working on the task above");
		expect(summary).not.toContain("Treat the interrupted turn as ended");
	});

	it("labels command-initiated transitions correctly", () => {
		const summary = buildWorkspaceTransitionSummary("/a", "/b", "command", true);

		expect(summary).toContain("(user command)");
		expect(summary).not.toContain("(tool request)");
	});

	it("reports untrusted workspace status", () => {
		const summary = buildWorkspaceTransitionSummary("/a", "/b", "tool", false);

		expect(summary).toContain("remain blocked because the target workspace is untrusted");
	});

	it("reports trusted workspace status", () => {
		const summary = buildWorkspaceTransitionSummary("/a", "/b", "tool", true);

		expect(summary).toContain("repo-controlled project surfaces are enabled");
	});
});
