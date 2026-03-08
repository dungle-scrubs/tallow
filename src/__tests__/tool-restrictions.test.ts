import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel } from "../../test-utils/mock-model.js";
import { createTallowSession, parseToolFlag } from "../sdk.js";

const tempDirs: string[] = [];
const sessionDisposers: Array<() => void> = [];

afterEach(() => {
	for (const dispose of sessionDisposers) {
		dispose();
	}
	sessionDisposers.length = 0;

	for (const dir of tempDirs) {
		rmSync(dir, { force: true, recursive: true });
	}
	tempDirs.length = 0;
});

/**
 * Create and track a temporary working directory for session tests.
 *
 * @returns Absolute temporary directory path
 */
function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tallow-tool-restrictions-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * Create a disposable in-memory session with the requested tool allowlist.
 *
 * @param toolFlag - Parsed tool flag value
 * @returns Sorted active tool names
 */
async function getActiveToolNames(toolFlag: ReturnType<typeof parseToolFlag>): Promise<string[]> {
	const tallow = await createTallowSession({
		apiKey: "mock-api-key",
		cwd: makeTempDir(),
		model: createMockModel(),
		noBundledSkills: true,
		provider: "mock",
		session: { type: "memory" },
		startupProfile: "headless",
		tools: toolFlag,
	});
	const disposable = tallow.session as { dispose?: () => void };
	sessionDisposers.push(() => {
		disposable.dispose?.();
	});
	return [...tallow.session.getActiveToolNames()].sort((a, b) => a.localeCompare(b));
}

describe("explicit tool restrictions", () => {
	test("--tools none disables all tools, including extension-registered ones", async () => {
		const activeTools = await getActiveToolNames(parseToolFlag("none"));
		expect(activeTools).toEqual([]);
	});

	test("--tools readonly keeps only readonly tools in the bundled profile", async () => {
		const activeTools = await getActiveToolNames(parseToolFlag("readonly"));
		expect(activeTools).toEqual(["find", "grep", "ls", "read"]);
	});
});
