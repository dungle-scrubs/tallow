import { afterEach, describe, expect, it } from "bun:test";
import type { Message } from "@mariozechner/pi-ai";
import {
	applyBackgroundResultRetention,
	compactBackgroundMessages,
	SUBAGENT_HISTORY_TAIL_MESSAGES_ENV,
	SUBAGENT_KEEP_FULL_HISTORY_ENV,
} from "../process.js";
import type { BackgroundSubagent } from "../widget.js";

const originalKeepFullHistory = process.env[SUBAGENT_KEEP_FULL_HISTORY_ENV];
const originalTailLimit = process.env[SUBAGENT_HISTORY_TAIL_MESSAGES_ENV];

/**
 * Build a minimal text message for retention tests.
 * @param role - Message role
 * @param text - Text payload
 * @returns Message object
 */
function textMessage(role: "assistant" | "user", text: string): Message {
	return {
		content: [{ text, type: "text" }],
		role,
	} as unknown as Message;
}

/**
 * Build a lightweight background subagent fixture.
 * @param messages - Message history for the fixture result
 * @returns Background-subagent fixture
 */
function makeBackgroundSubagent(messages: Message[]): BackgroundSubagent {
	return {
		agent: "worker",
		id: "bg_test",
		process: { kill: () => true } as unknown as BackgroundSubagent["process"],
		result: {
			agent: "worker",
			agentSource: "user",
			exitCode: 0,
			messages,
			stderr: "",
			task: "run checks",
			usage: {
				cacheRead: 0,
				cacheWrite: 0,
				contextTokens: 0,
				cost: 0,
				denials: 0,
				input: 0,
				output: 0,
				turns: 0,
			},
		},
		startTime: Date.now(),
		status: "completed",
		task: "run checks",
	};
}

/**
 * Restore retention env overrides after each test.
 * @returns void
 */
function restoreEnv(): void {
	if (originalKeepFullHistory === undefined) {
		delete process.env[SUBAGENT_KEEP_FULL_HISTORY_ENV];
	} else {
		process.env[SUBAGENT_KEEP_FULL_HISTORY_ENV] = originalKeepFullHistory;
	}
	if (originalTailLimit === undefined) {
		delete process.env[SUBAGENT_HISTORY_TAIL_MESSAGES_ENV];
	} else {
		process.env[SUBAGENT_HISTORY_TAIL_MESSAGES_ENV] = originalTailLimit;
	}
}

afterEach(() => {
	restoreEnv();
});

describe("subagent background-history retention", () => {
	it("keeps bounded tail and still preserves final output text", () => {
		const messages = [
			textMessage("assistant", "final-summary"),
			textMessage("user", "debug-1"),
			textMessage("user", "debug-2"),
		];

		const compacted = compactBackgroundMessages(messages, 1);
		expect(compacted.originalMessageCount).toBe(3);
		expect(compacted.retainedMessageCount).toBe(2);
		expect(compacted.finalOutput).toBe("final-summary");
		expect(compacted.compactedMessages[0]?.role).toBe("user");
		expect(compacted.compactedMessages[1]?.role).toBe("assistant");
	});

	it("compacts completed background results by default", () => {
		delete process.env[SUBAGENT_KEEP_FULL_HISTORY_ENV];
		process.env[SUBAGENT_HISTORY_TAIL_MESSAGES_ENV] = "2";

		const subagent = makeBackgroundSubagent([
			textMessage("assistant", "step-1"),
			textMessage("assistant", "step-2"),
			textMessage("assistant", "step-3"),
			textMessage("assistant", "step-4"),
		]);

		applyBackgroundResultRetention(subagent);
		expect(subagent.historyCompacted).toBe(true);
		expect(subagent.historyOriginalMessageCount).toBe(4);
		expect(subagent.historyRetainedMessageCount).toBe(2);
		expect(subagent.retainedFinalOutput).toBe("step-4");
		expect(subagent.result.messages).toHaveLength(2);
		expect(subagent.result.messages[1]?.role).toBe("assistant");
	});

	it("keeps full history when debug override is enabled", () => {
		process.env[SUBAGENT_KEEP_FULL_HISTORY_ENV] = "1";
		process.env[SUBAGENT_HISTORY_TAIL_MESSAGES_ENV] = "1";

		const subagent = makeBackgroundSubagent([
			textMessage("assistant", "a"),
			textMessage("assistant", "b"),
			textMessage("assistant", "c"),
		]);

		applyBackgroundResultRetention(subagent);
		expect(subagent.historyCompacted).toBe(false);
		expect(subagent.historyOriginalMessageCount).toBe(3);
		expect(subagent.historyRetainedMessageCount).toBe(3);
		expect(subagent.result.messages).toHaveLength(3);
		expect(subagent.retainedFinalOutput).toBe("c");
	});
});
