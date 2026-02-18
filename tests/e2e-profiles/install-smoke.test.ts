/**
 * E2E: Install smoke test.
 *
 * Runs the installer in headless mode against a temp directory, then
 * verifies the directory structure and boots a session from it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTallowSession } from "../../src/sdk.js";
import { createEchoStreamFn, createMockModel } from "../../test-utils/mock-model.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const INSTALL_SCRIPT = join(PROJECT_ROOT, "dist/install.js");

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

describe("Install Smoke Test", () => {
	it("headless install creates expected directory structure", () => {
		tmpHome = mkdtempSync(join(tmpdir(), "tallow-install-e2e-"));

		// Run installer in headless mode with a mock provider.
		// Use TALLOW_API_KEY_REF (op:// reference) to avoid macOS Keychain access.
		execFileSync("node", [INSTALL_SCRIPT, "--yes", "--default-provider", "mock"], {
			env: {
				...process.env,
				HOME: tmpHome,
				TALLOW_HOME: join(tmpHome, ".tallow"),
				TALLOW_API_KEY_REF: "op://Test/mock/api-key",
			},
			cwd: PROJECT_ROOT,
			timeout: 30_000,
			stdio: "pipe",
		});

		const tallowDir = join(tmpHome, ".tallow");
		expect(existsSync(tallowDir)).toBe(true);
		expect(existsSync(join(tallowDir, "settings.json"))).toBe(true);
		expect(existsSync(join(tallowDir, "sessions"))).toBe(true);

		// Agents should be copied from templates
		const agentsDir = join(tallowDir, "agents");
		if (existsSync(agentsDir)) {
			const agents = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
			expect(agents.length).toBeGreaterThan(0);
		}
	});

	it("settings.json is valid JSON after install", () => {
		tmpHome = mkdtempSync(join(tmpdir(), "tallow-install-e2e-"));

		execFileSync("node", [INSTALL_SCRIPT, "--yes", "--default-provider", "mock"], {
			env: {
				...process.env,
				HOME: tmpHome,
				TALLOW_HOME: join(tmpHome, ".tallow"),
				TALLOW_API_KEY_REF: "op://Test/mock/api-key",
			},
			cwd: PROJECT_ROOT,
			timeout: 30_000,
			stdio: "pipe",
		});

		const settingsPath = join(tmpHome, ".tallow", "settings.json");
		const content = readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(content);

		expect(parsed).toBeObject();
		expect(parsed).toHaveProperty("defaultProvider", "mock");
	});

	it("installed home boots a session successfully", async () => {
		tmpHome = mkdtempSync(join(tmpdir(), "tallow-install-e2e-"));

		execFileSync("node", [INSTALL_SCRIPT, "--yes", "--default-provider", "mock"], {
			env: {
				...process.env,
				HOME: tmpHome,
				TALLOW_HOME: join(tmpHome, ".tallow"),
				TALLOW_API_KEY_REF: "op://Test/mock/api-key",
			},
			cwd: PROJECT_ROOT,
			timeout: 30_000,
			stdio: "pipe",
		});

		const originalHome = process.env.TALLOW_HOME;
		process.env.TALLOW_HOME = join(tmpHome, ".tallow");

		try {
			const tallow = await createTallowSession({
				cwd: tmpHome,
				model: createMockModel(),
				provider: "mock",
				apiKey: "mock-api-key",
				session: { type: "memory" },
				noBundledSkills: true,
			});

			tallow.session.agent.streamFn = createEchoStreamFn();

			// Extensions should have loaded (bundled ones discovered from package)
			expect(tallow.extensions.extensions.length).toBeGreaterThan(0);

			// Session should accept a prompt
			const events: unknown[] = [];
			const unsub = tallow.session.subscribe((e) => events.push(e));
			await tallow.session.prompt("smoke test");
			unsub();

			expect(events.length).toBeGreaterThan(0);
		} finally {
			if (originalHome !== undefined) {
				process.env.TALLOW_HOME = originalHome;
			} else {
				delete process.env.TALLOW_HOME;
			}
		}
	});
});
