import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import { MEMORY_RELEASE_EVENTS } from "../../_shared/memory-release-events.js";
import sessionMemory, {
	getSessionMemoryIndexerForTests,
	setSessionMemoryIndexerForTests,
} from "../index.js";
import { SessionIndexer } from "../indexer.js";

let harness: ExtensionHarness;
let tempDir: string;

beforeEach(async () => {
	harness = ExtensionHarness.create();
	await harness.loadExtension(sessionMemory);
	tempDir = mkdtempSync(join(tmpdir(), "tallow-session-memory-release-test-"));
});

afterEach(() => {
	setSessionMemoryIndexerForTests(null);
	rmSync(tempDir, { recursive: true, force: true });
});

describe("session-memory release lifecycle", () => {
	it("releases the singleton indexer after memory-release completion event", () => {
		const dbPath = join(tempDir, "index.db");
		const indexer = new SessionIndexer(dbPath);
		setSessionMemoryIndexerForTests(indexer);

		expect(getSessionMemoryIndexerForTests()).toBe(indexer);

		harness.eventBus.emit(MEMORY_RELEASE_EVENTS.completed, {
			command: "release-memory",
			reason: "manual",
			schemaVersion: 1,
			source: "run_slash_command",
			timestamp: Date.now(),
		});

		expect(getSessionMemoryIndexerForTests()).toBeNull();
	});

	it("releases the singleton indexer on session shutdown", async () => {
		const dbPath = join(tempDir, "index.db");
		const indexer = new SessionIndexer(dbPath);
		setSessionMemoryIndexerForTests(indexer);

		expect(getSessionMemoryIndexerForTests()).toBe(indexer);

		await harness.fireEvent("session_shutdown", { type: "session_shutdown" });

		expect(getSessionMemoryIndexerForTests()).toBeNull();
	});
});
