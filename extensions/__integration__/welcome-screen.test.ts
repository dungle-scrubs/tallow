/**
 * E2E integration test for the welcome-screen extension.
 *
 * Boots a real tallow session with the bundled welcome-screen extension,
 * binds extensions with a mock UI, and verifies:
 * - setHeader IS called on fresh sessions
 * - The rendered output contains the ASCII logo and version
 * - setHeader is NOT called on resumed sessions with conversation history
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@mariozechner/pi-tui";
import { TALLOW_VERSION } from "../../src/config.js";
import { createTallowSession, type TallowSession } from "../../src/sdk.js";
import { withExclusiveTallowHome } from "../../test-utils/tallow-home-env.js";
import welcomeScreenExtension from "../welcome-screen/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Lines the ASCII logo must contain (stripped of ANSI). */
const LOGO_FRAGMENTS = ["▐████████████▌", "████", "▐█▌"];

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires matching \x1b
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI escape sequences for content assertions. */
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

/**
 * Create a session with only the welcome-screen extension loaded.
 *
 * @param cwd - Working directory for the session
 * @returns TallowSession promise
 */
function createWelcomeSession(cwd: string): Promise<TallowSession> {
	return withExclusiveTallowHome(cwd, () =>
		createTallowSession({
			cwd,
			provider: "anthropic",
			apiKey: "test-key",
			session: { type: "memory" },
			noBundledExtensions: true,
			noBundledSkills: true,
			extensionFactories: [welcomeScreenExtension],
		})
	);
}

/**
 * Build a mock UI context that captures setHeader calls.
 *
 * @returns Object with the UI context and captured state
 */
function createCapturingUI(): {
	uiContext: Record<string, unknown>;
	capture: {
		setHeaderCalled: boolean;
		headerFactory: ((tui: unknown, theme: unknown) => { render(w: number): string[] }) | null;
	};
} {
	const capture = {
		setHeaderCalled: false,
		headerFactory: null as
			| ((tui: unknown, theme: unknown) => { render(w: number): string[] })
			| null,
	};

	const uiContext: Record<string, unknown> = {
		notify: () => {},
		confirm: async () => true,
		input: async () => null,
		select: async () => null,
		custom: async () => null,
		setWorkingMessage: () => {},
		setHeader: (factory: typeof capture.headerFactory) => {
			capture.setHeaderCalled = true;
			capture.headerFactory = factory;
		},
		setFooter: () => {},
		setToolsExpanded: () => {},
		setEditorComponent: () => {},
		addTerminalInputListener: () => () => {},
		setStatus: () => {},
		setWidget: () => {},
		setTitle: () => {},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		hasUI: true,
	};
	return { uiContext, capture };
}

let tmpDir: string | undefined;
let session: TallowSession | undefined;

afterEach(() => {
	if (tmpDir) {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		tmpDir = undefined;
	}
	session = undefined;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("welcome-screen E2E", () => {
	it("calls setHeader with the ASCII logo on a fresh session", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tallow-welcome-e2e-"));
		session = await createWelcomeSession(tmpDir);

		const { uiContext, capture } = createCapturingUI();
		await session.session.bindExtensions({ uiContext });

		// ── setHeader must have been invoked ──
		expect(capture.setHeaderCalled).toBe(true);
		expect(capture.headerFactory).not.toBeNull();

		// ── Render the header and validate content ──
		const component = capture.headerFactory?.(null, null);
		expect(component).toBeDefined();
		expect(typeof component?.render).toBe("function");

		const lines = component?.render(80) ?? [];
		const plainLines = lines.map(stripAnsi);
		const joined = plainLines.join("\n");

		// Logo fragments must be present
		for (const frag of LOGO_FRAGMENTS) {
			expect(joined).toContain(frag);
		}

		// Version string must be present
		expect(joined).toContain(`tallow v${TALLOW_VERSION}`);
	}, 30_000);

	it("renders lines centered within the given width", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tallow-welcome-e2e-"));
		session = await createWelcomeSession(tmpDir);

		const { uiContext, capture } = createCapturingUI();
		await session.session.bindExtensions({ uiContext });

		const component = capture.headerFactory?.(null, null);
		expect(component).toBeDefined();

		const width = 120;
		const lines = component?.render(width) ?? [];

		// Every line should fit within the width
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		// Logo lines should be approximately centered (left padding > 0)
		const logoLine = lines[0]; // first line = logo top bar
		const leading = logoLine.length - logoLine.trimStart().length;
		expect(leading).toBeGreaterThan(0);
	}, 30_000);

	it("does NOT call setHeader on a resumed session with conversation entries", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tallow-welcome-e2e-"));
		session = await createWelcomeSession(tmpDir);

		// Inject conversation entries to simulate a resumed session
		const sm = session.session.sessionManager;
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
		});
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
		});

		const { uiContext, capture } = createCapturingUI();
		await session.session.bindExtensions({ uiContext });

		// setHeader must NOT be called for resumed sessions
		expect(capture.setHeaderCalled).toBe(false);
	}, 30_000);

	it("does NOT skip fresh sessions that only have metadata entries", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tallow-welcome-e2e-"));
		session = await createWelcomeSession(tmpDir);

		// Verify metadata entries exist but don't prevent the welcome screen
		const entries = session.session.sessionManager.getEntries();
		const metadataOnly = entries.every(
			(e) => !("role" in e) || !["user", "assistant"].includes(String(e.role))
		);
		expect(metadataOnly).toBe(true);
		expect(entries.length).toBeGreaterThan(0); // model_change, thinking_level_change

		const { uiContext, capture } = createCapturingUI();
		await session.session.bindExtensions({ uiContext });

		// setHeader MUST be called even though metadata entries exist
		expect(capture.setHeaderCalled).toBe(true);
	}, 30_000);

	it("defaults quietStartup to true so resource listing is suppressed", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tallow-welcome-e2e-"));
		session = await createWelcomeSession(tmpDir);

		// The settingsManager should have quietStartup=true by default,
		// which suppresses the keybinding hints and [Context]/[Skills] listing.
		const quiet = session.session.settingsManager.getQuietStartup();
		expect(quiet).toBe(true);
	}, 30_000);

	it("respects explicit quietStartup=false override", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tallow-welcome-e2e-"));
		session = await withExclusiveTallowHome(tmpDir, () =>
			createTallowSession({
				cwd: tmpDir ?? tmpdir(),
				provider: "anthropic",
				apiKey: "test-key",
				session: { type: "memory" },
				noBundledExtensions: true,
				noBundledSkills: true,
				extensionFactories: [welcomeScreenExtension],
				settings: { quietStartup: false },
			})
		);

		// User explicitly opted out — resource listing should be visible
		const quiet = session.session.settingsManager.getQuietStartup();
		expect(quiet).toBe(false);
	}, 30_000);
});
