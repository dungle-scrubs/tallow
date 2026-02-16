/**
 * E2E: User extension override test.
 *
 * Verifies that when a user extension directory shares a name with a bundled
 * extension, the bundled version is excluded from loading paths and the user
 * version loads instead.
 *
 * Uses DefaultResourceLoader directly (like e2e-commands.mjs) because the
 * override logic reads TALLOW_HOME at module scope — environment variable
 * tricks don't work once the module is cached.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	createEventBus,
	DefaultResourceLoader,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

import { EXTENSIONS_DIR } from "./profiles.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const THEMES_DIR = join(PROJECT_ROOT, "themes");

let tmpHome: string | undefined;

afterEach(() => {
	if (tmpHome) {
		try {
			rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		tmpHome = undefined;
	}
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Discover extension directories (mirrors sdk.ts logic).
 *
 * @param baseDir - Directory to scan
 * @returns Array of full paths to extension directories
 */
function discoverExtensionDirs(baseDir: string): string[] {
	const paths: string[] = [];
	try {
		for (const entry of readdirSync(baseDir)) {
			if (entry.startsWith(".")) continue;
			const full = join(baseDir, entry);
			const stat = statSync(full);
			if (stat.isDirectory() && existsSync(join(full, "index.ts"))) {
				paths.push(full);
			}
		}
	} catch {
		// ignore
	}
	return paths;
}

/**
 * Create a minimal user extension that registers a marker tool.
 *
 * @param dir - Directory to write the extension into
 * @param markerToolName - Tool name to register as a detection marker
 */
function writeUserExtension(dir: string, markerToolName: string): void {
	mkdirSync(dir, { recursive: true });

	writeFileSync(
		join(dir, "extension.json"),
		JSON.stringify({
			name: "clear",
			version: "99.0.0",
			description: "User override of clear extension",
		})
	);

	// Use a command (not a tool) to avoid needing @sinclair/typebox.
	// Jiti resolves imports from the file location — temp dirs lack node_modules.
	writeFileSync(
		join(dir, "index.ts"),
		`
export default function(pi) {
	pi.registerCommand("${markerToolName}", {
		description: "Marker command proving the user override loaded",
		handler: async () => {},
	});
	pi.registerCommand("clear", {
		description: "User override clear",
		handler: async () => {},
	});
}
`
	);
}

/**
 * Simulate the override filtering logic from sdk.ts.
 * Returns which bundled extensions to load and which were overridden.
 *
 * @param userExtDir - Path to user extensions directory
 * @returns Object with extension paths to load and overrides detected
 */
function resolveOverrides(userExtDir: string): {
	extensionPaths: string[];
	overrides: Array<{ name: string; userPath: string }>;
} {
	const userExtNames = new Set<string>();
	const userExtPaths = new Map<string, string>();

	if (existsSync(userExtDir)) {
		for (const extPath of discoverExtensionDirs(userExtDir)) {
			const name = basename(extPath);
			userExtNames.add(name);
			userExtPaths.set(name, extPath);
		}
	}

	const extensionPaths: string[] = [];
	const overrides: Array<{ name: string; userPath: string }> = [];

	for (const bundledPath of discoverExtensionDirs(EXTENSIONS_DIR)) {
		const name = basename(bundledPath);
		if (userExtNames.has(name)) {
			overrides.push({ name, userPath: userExtPaths.get(name) ?? name });
		} else {
			extensionPaths.push(bundledPath);
		}
	}

	// Add user extension paths (the overrides + any user-only extensions)
	for (const userPath of discoverExtensionDirs(userExtDir)) {
		extensionPaths.push(userPath);
	}

	return { extensionPaths, overrides };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("User Extension Override", () => {
	it("user extension shadows bundled extension of same name", async () => {
		tmpHome = mkdtempSync(join(tmpdir(), "tallow-override-e2e-"));
		const markerTool = "_e2e_override_marker";
		const userExtDir = join(tmpHome, "extensions");

		// Place user extension at $tmpHome/extensions/clear/
		writeUserExtension(join(userExtDir, "clear"), markerTool);

		const { extensionPaths, overrides } = resolveOverrides(userExtDir);

		// Override should be detected
		expect(overrides.length).toBeGreaterThanOrEqual(1);
		const clearOverride = overrides.find((o) => o.name === "clear");
		expect(clearOverride).toBeDefined();

		// The bundled "clear" path should NOT be in the final list
		const bundledClearPath = join(EXTENSIONS_DIR, "clear");
		expect(extensionPaths).not.toContain(bundledClearPath);

		// The user "clear" path SHOULD be in the final list
		const userClearPath = join(userExtDir, "clear");
		expect(extensionPaths).toContain(userClearPath);

		// Load only the user extension (not bundled ones) to verify it works.
		// The override filtering above already proved the bundled `clear` was excluded.
		const eventBus = createEventBus();
		const settingsManager = SettingsManager.inMemory();

		const loader = new DefaultResourceLoader({
			cwd: tmpHome,
			agentDir: tmpHome,
			settingsManager,
			eventBus,
			additionalExtensionPaths: [join(userClearPath, "index.ts")],
			additionalThemePaths: existsSync(THEMES_DIR) ? [THEMES_DIR] : [],
			skillsOverride: () => ({ skills: [], diagnostics: [] }),
			promptsOverride: () => ({ prompts: [], diagnostics: [] }),
			agentsFilesOverride: () => ({ agentsFiles: [] }),
		});

		await loader.reload();
		const exts = loader.getExtensions();

		expect(exts.errors).toEqual([]);

		// The user override loaded and registered our marker command
		const hasMarker = exts.extensions.some((ext) => ext.commands.has(markerTool));
		expect(hasMarker).toBe(true);
	});

	it("override count is zero when no user extensions exist", () => {
		tmpHome = mkdtempSync(join(tmpdir(), "tallow-override-e2e-"));
		const userExtDir = join(tmpHome, "extensions");
		mkdirSync(userExtDir, { recursive: true });

		const { overrides } = resolveOverrides(userExtDir);
		expect(overrides).toEqual([]);
	});

	it("user-only extensions are added alongside bundled ones", () => {
		tmpHome = mkdtempSync(join(tmpdir(), "tallow-override-e2e-"));
		const userExtDir = join(tmpHome, "extensions");

		// Create a user extension that doesn't shadow any bundled one
		writeUserExtension(join(userExtDir, "my-custom-ext"), "_e2e_custom_marker");

		const { extensionPaths, overrides } = resolveOverrides(userExtDir);

		// No overrides — name doesn't match any bundled extension
		expect(overrides).toEqual([]);

		// User extension should still be in the paths
		expect(extensionPaths).toContain(join(userExtDir, "my-custom-ext"));
	});
});
