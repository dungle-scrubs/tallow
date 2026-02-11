/**
 * Tests for the SessionIndexer.
 *
 * Uses node:test instead of bun:test because better-sqlite3 is a native
 * Node.js addon that isn't supported by Bun's runtime.
 *
 * Run with: npx tsx --test extensions/session-memory/__tests__/indexer.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { SessionIndexer } from "../indexer.js";

/**
 * Create a session JSONL file with typed events.
 *
 * @param dir - Directory to write the file in
 * @param id - Session UUID
 * @param cwd - Session working directory
 * @param timestamp - Session start timestamp
 * @param messages - Array of {role, text} message pairs
 * @returns Path to the created file
 */
function createSessionFile(
	dir: string,
	id: string,
	cwd: string,
	timestamp: string,
	messages: Array<{ role: string; text: string }>
): string {
	const lines: string[] = [];

	lines.push(JSON.stringify({ type: "session", version: 3, id, timestamp, cwd }));

	for (const msg of messages) {
		// Assistant messages include thinking + toolCall blocks that should be stripped
		const content =
			msg.role === "assistant"
				? [
						{ type: "thinking", thinking: "internal thoughts should not be indexed" },
						{ type: "text", text: msg.text },
						{ type: "toolCall", id: "tool_123", name: "bash", arguments: { command: "ls" } },
					]
				: [{ type: "text", text: msg.text }];

		lines.push(
			JSON.stringify({
				type: "message",
				id: Math.random().toString(36).slice(2, 10),
				timestamp,
				message: { role: msg.role, content, timestamp: Date.now() },
			})
		);
	}

	const filename = `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`;
	const filePath = join(dir, filename);
	writeFileSync(filePath, lines.join("\n"));
	return filePath;
}

describe("SessionIndexer", () => {
	let tmpDir: string;
	let sessionsDir: string;
	let indexer: SessionIndexer;

	before(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "session-memory-test-"));
		sessionsDir = join(tmpDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		indexer = new SessionIndexer(join(sessionsDir, "index.db"));
	});

	after(() => {
		indexer.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("indexes a session file and makes it searchable", async () => {
		createSessionFile(sessionsDir, "sess-1", "/Users/kevin/dev/my-app", "2026-02-10T10:00:00Z", [
			{ role: "user", text: "Add a visual sell section to the standalone view" },
			{
				role: "assistant",
				text: "I'll add a hero section with a tagline and three feature highlights",
			},
		]);

		await indexer.indexSessions(sessionsDir);

		const results = indexer.search("visual sell standalone");
		assert.ok(results.length > 0, "Should find at least one result");
		assert.ok(results[0].matchedTurn.userText.includes("visual sell"));
		assert.equal(results[0].project, "my-app");
	});

	it("pairs user and assistant messages into turns", async () => {
		createSessionFile(sessionsDir, "sess-2", "/Users/kevin/dev/tallow", "2026-02-10T11:00:00Z", [
			{ role: "user", text: "first question" },
			{ role: "assistant", text: "first answer" },
			{ role: "user", text: "second question" },
			{ role: "assistant", text: "second answer" },
		]);

		await indexer.indexSessions(sessionsDir);

		const results = indexer.search("first question");
		assert.equal(results.length, 1);
		assert.equal(results[0].matchedTurn.userText, "first question");
		assert.equal(results[0].matchedTurn.assistantText, "first answer");
	});

	it("provides ±1 context turns around matches", async () => {
		createSessionFile(sessionsDir, "sess-3", "/Users/kevin/dev/tallow", "2026-02-10T12:00:00Z", [
			{ role: "user", text: "context before this turn" },
			{ role: "assistant", text: "before answer" },
			{ role: "user", text: "the matched query turn" },
			{ role: "assistant", text: "matched answer" },
			{ role: "user", text: "context after this turn" },
			{ role: "assistant", text: "after answer" },
		]);

		await indexer.indexSessions(sessionsDir);

		const results = indexer.search("matched query");
		assert.equal(results.length, 1);
		assert.equal(results[0].contextBefore?.userText, "context before this turn");
		assert.equal(results[0].contextAfter?.userText, "context after this turn");
	});

	it("excludes the current session from indexing", async () => {
		createSessionFile(
			sessionsDir,
			"current-session",
			"/Users/kevin/dev/tallow",
			"2026-02-10T13:00:00Z",
			[
				{ role: "user", text: "this is a unique searchable phrase xyzzy" },
				{ role: "assistant", text: "response" },
			]
		);

		await indexer.indexSessions(sessionsDir, "current-session");

		const results = indexer.search("xyzzy");
		assert.equal(results.length, 0);
	});

	it("filters by project name", async () => {
		createSessionFile(sessionsDir, "sess-a", "/Users/kevin/dev/alpha", "2026-02-10T14:00:00Z", [
			{ role: "user", text: "deploy the alpha application" },
			{ role: "assistant", text: "deploying alpha" },
		]);
		createSessionFile(sessionsDir, "sess-b", "/Users/kevin/dev/beta", "2026-02-10T15:00:00Z", [
			{ role: "user", text: "deploy the beta application" },
			{ role: "assistant", text: "deploying beta" },
		]);

		await indexer.indexSessions(sessionsDir);

		const alphaResults = indexer.search("deploy application", { project: "alpha" });
		assert.equal(alphaResults.length, 1);
		assert.equal(alphaResults[0].project, "alpha");

		const allResults = indexer.search("deploy application");
		assert.equal(allResults.length, 2);
	});

	it("handles sessions with only user messages (no assistant response)", async () => {
		createSessionFile(
			sessionsDir,
			"sess-user-only",
			"/Users/kevin/dev/tallow",
			"2026-02-10T17:00:00Z",
			[{ role: "user", text: "orphaned question with no response" }]
		);

		await indexer.indexSessions(sessionsDir);

		const results = indexer.search("orphaned question");
		assert.equal(results.length, 1);
		assert.equal(results[0].matchedTurn.assistantText, "");
	});

	it("strips thinking and toolCall blocks from assistant messages", async () => {
		createSessionFile(
			sessionsDir,
			"sess-clean",
			"/Users/kevin/dev/tallow",
			"2026-02-10T18:00:00Z",
			[
				{ role: "user", text: "clean extraction test zqwerty" },
				{ role: "assistant", text: "only this visible text should be indexed" },
			]
		);

		await indexer.indexSessions(sessionsDir);

		// "internal thoughts" is in the thinking block — should NOT be searchable
		const thinkingResults = indexer.search("internal thoughts indexed");
		const hasThisSession = thinkingResults.some((r) => r.sessionId === "sess-clean");
		assert.equal(hasThisSession, false, "Thinking blocks should not be indexed");

		// The text block should be searchable
		const textResults = indexer.search("visible text indexed");
		assert.ok(textResults.length > 0);
	});

	it("listSessions returns indexed session metadata", async () => {
		// Sessions from previous tests should be indexed
		const sessions = indexer.listSessions();
		assert.ok(sessions.length > 0);

		// Most recent first
		const dates = sessions.map((s) => s.startedAt);
		const sorted = [...dates].sort().reverse();
		assert.deepEqual(dates, sorted);
	});

	it("uses FTS5 stemming — 'designing' matches 'design'", async () => {
		createSessionFile(sessionsDir, "sess-stem", "/Users/kevin/dev/tallow", "2026-02-10T19:00:00Z", [
			{ role: "user", text: "I was designing the new zqplayout" },
			{ role: "assistant", text: "The zqplayout design looks good" },
		]);

		await indexer.indexSessions(sessionsDir);

		// Search for "design" should match "designing"
		const results = indexer.search("zqplayout design");
		assert.ok(results.length > 0, "Porter stemming should match 'designing' with 'design'");
	});
});
