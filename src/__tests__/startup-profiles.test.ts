import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createMockModel } from "../../test-utils/mock-model.js";
import { createTallowSession, parseToolFlag, type TallowSession } from "../sdk.js";

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
 * Create and track a temporary directory for test resources.
 *
 * @param prefix - Directory prefix used for mkdtemp
 * @returns Absolute temporary directory path
 */
function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/**
 * Create an isolated in-memory session for startup-profile tests.
 *
 * @param options - Startup profile and extension options
 * @returns Initialized tallow session
 */
async function createProfileSession(options: {
	readonly additionalExtensions: readonly string[];
	readonly startupProfile: "interactive" | "headless";
	readonly tools?: ReturnType<typeof parseToolFlag>;
}): Promise<TallowSession> {
	const tallow = await createTallowSession({
		additionalExtensions: [...options.additionalExtensions],
		cwd: makeTempDir("tallow-startup-profile-cwd-"),
		extensionsOnly: true,
		model: createMockModel(),
		provider: "mock",
		apiKey: "mock-api-key",
		session: { type: "memory" },
		startupProfile: options.startupProfile,
		noBundledSkills: true,
		tools: options.tools,
	});

	sessionDisposers.push(() => {
		const disposable = tallow.session as { dispose?: () => void };
		disposable.dispose?.();
	});

	return tallow;
}

/**
 * Get sorted extension IDs from a loaded tallow session.
 *
 * @param tallow - Session returned from createTallowSession
 * @returns Sorted extension directory basenames
 */
function getLoadedExtensionIds(tallow: TallowSession): string[] {
	return tallow.extensions.extensions
		.map((extension) => basename(extension.path))
		.sort((a, b) => a.localeCompare(b));
}

/**
 * Create a synthetic UI-category extension that declares tool capability.
 *
 * This verifies headless startup does not skip UI-category extensions when
 * their manifest advertises tool capability.
 *
 * @returns Absolute extension directory path
 */
function createUiToolExtension(): string {
	const extensionDir = makeTempDir("tallow-ui-tool-extension-");
	mkdirSync(extensionDir, { recursive: true });

	writeFileSync(
		join(extensionDir, "extension.json"),
		JSON.stringify(
			{
				name: "ui-tool-extension-test",
				version: "0.0.0",
				description: "startup-profile test extension",
				category: "ui",
				capabilities: {
					tools: ["ui_headless_test_tool"],
				},
			},
			null,
			2
		)
	);

	writeFileSync(
		join(extensionDir, "index.ts"),
		[
			'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";',
			"",
			"export default function registerUiToolExtension(_pi: ExtensionAPI): void {",
			"\t// No-op: capability declaration in extension.json is enough for policy checks.",
			"}",
			"",
		].join("\n")
	);

	return extensionDir;
}

describe("startup profile extension loading", () => {
	test("interactive profile keeps selected UI extensions", async () => {
		const tallow = await createProfileSession({
			additionalExtensions: ["clear", "prompt-suggestions"],
			startupProfile: "interactive",
		});

		const loaded = getLoadedExtensionIds(tallow);
		expect(loaded).toContain("clear");
		expect(loaded).toContain("prompt-suggestions");
	});

	test("headless profile skips pure UI extensions", async () => {
		const tallow = await createProfileSession({
			additionalExtensions: ["clear", "prompt-suggestions"],
			startupProfile: "headless",
		});

		const loaded = getLoadedExtensionIds(tallow);
		expect(loaded).toContain("clear");
		expect(loaded).not.toContain("prompt-suggestions");
	});

	test("headless profile preserves UI extensions that declare tools", async () => {
		const uiToolExtension = createUiToolExtension();
		const tallow = await createProfileSession({
			additionalExtensions: [uiToolExtension],
			startupProfile: "headless",
		});

		const loaded = getLoadedExtensionIds(tallow);

		expect(tallow.extensions.errors).toEqual([]);
		expect(loaded).toContain(basename(uiToolExtension));
	});
});

describe("headless tool guarantees", () => {
	test("headless startup keeps default coding tools available", async () => {
		const tallow = await createProfileSession({
			additionalExtensions: ["clear"],
			startupProfile: "headless",
		});
		const activeTools = tallow.session.getActiveToolNames();

		expect(activeTools).toContain("read");
		expect(activeTools).toContain("bash");
		expect(activeTools).toContain("edit");
		expect(activeTools).toContain("write");
	});

	test("headless startup preserves readonly tool guarantees", async () => {
		const tallow = await createProfileSession({
			additionalExtensions: ["clear"],
			startupProfile: "headless",
			tools: parseToolFlag("readonly"),
		});
		const activeTools = tallow.session.getActiveToolNames();

		expect(activeTools).toContain("read");
		expect(activeTools).toContain("grep");
		expect(activeTools).toContain("find");
		expect(activeTools).toContain("ls");
		expect(activeTools).not.toContain("bash");
		expect(activeTools).not.toContain("edit");
		expect(activeTools).not.toContain("write");
	});
});
