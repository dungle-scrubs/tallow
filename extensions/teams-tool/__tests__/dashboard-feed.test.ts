import { afterEach, describe, expect, it } from "bun:test";
import {
	DASHBOARD_FEED_SUMMARY_CHARS,
	shouldSuppressDashboardFeedEvent,
	summarizeFeedMessage,
} from "../dashboard/feed";
import {
	appendDashboardFeedEvent,
	clearDashboardFeedEvents,
	getDashboardFeedEvents,
} from "../dashboard/state";

const TEAM = "feed-test-team";

/**
 * Reset dashboard feed state for test isolation.
 * @returns void
 */
function resetFeedState(): void {
	clearDashboardFeedEvents(TEAM);
}

afterEach(() => {
	resetFeedState();
});

describe("dashboard feed summarization", () => {
	it("strips markdown and transport prefixes from summaries", () => {
		const summary = summarizeFeedMessage(
			"Message from orchestrator: **Ship** [docs](https://x.dev)"
		);
		expect(summary).toBe("Ship docs");
	});

	it("keeps meaningful updates when leading lines are suppressed", () => {
		const content = "Running tool: read\nCompleted #2: auth tests";
		expect(shouldSuppressDashboardFeedEvent(content)).toBe(false);
		expect(summarizeFeedMessage(content)).toBe("Completed #2: auth tests");
	});

	it("suppresses low-signal lifecycle chatter", () => {
		expect(shouldSuppressDashboardFeedEvent("Started work.")).toBe(true);
		expect(shouldSuppressDashboardFeedEvent("Went idle.")).toBe(true);
		expect(shouldSuppressDashboardFeedEvent("Queued follow-up for @alice")).toBe(true);
	});

	it("does not suppress meaningful task and error updates", () => {
		expect(shouldSuppressDashboardFeedEvent("Claimed #1: Set up fixtures")).toBe(false);
		expect(shouldSuppressDashboardFeedEvent("Failed #7: lint step")).toBe(false);
		expect(shouldSuppressDashboardFeedEvent("Errored: timeout while waiting for result")).toBe(
			false
		);
	});

	it("truncates overlong summaries with ellipsis", () => {
		const message = `Message from orchestrator: ${"x".repeat(DASHBOARD_FEED_SUMMARY_CHARS + 20)}`;
		const summary = summarizeFeedMessage(message);
		expect(summary.length).toBe(DASHBOARD_FEED_SUMMARY_CHARS);
		expect(summary.endsWith("…")).toBe(true);
	});
});

describe("dashboard feed state", () => {
	it("deduplicates repeated summaries within the suppression window", () => {
		const originalNow = Date.now;
		let now = 1_000;
		Date.now = () => now;

		try {
			appendDashboardFeedEvent(TEAM, "alice", "all", "Claimed #1: setup");
			now += 800;
			appendDashboardFeedEvent(TEAM, "alice", "all", "Claimed #1: setup");
			expect(getDashboardFeedEvents(TEAM)).toHaveLength(1);

			now += 2_600;
			appendDashboardFeedEvent(TEAM, "alice", "all", "Claimed #1: setup");
			expect(getDashboardFeedEvents(TEAM)).toHaveLength(2);
		} finally {
			Date.now = originalNow;
		}
	});

	it("drops suppressed events before they enter the feed", () => {
		appendDashboardFeedEvent(TEAM, "alice", "all", "Running tool: read");
		expect(getDashboardFeedEvents(TEAM)).toEqual([]);
	});
});
