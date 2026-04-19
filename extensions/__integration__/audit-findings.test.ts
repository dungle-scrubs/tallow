/**
 * Integration tests for issues identified in the repository audit.
 *
 * Covers:
 * - Dead cwd_changed listener removal
 * - session_shutdown type safety (no 'as never' casts)
 * - Tool restriction enforcement
 * - Extension startup policy filtering
 * - session_shutdown handlers fire during cleanup
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { ExtensionHarness } from "../../test-utils/extension-harness.js";

// ════════════════════════════════════════════════════════════════
// Audit Finding 1.1: Dead cwd_changed listener removed
// ════════════════════════════════════════════════════════════════

describe("cwd_changed event listener removal", () => {
	it("sdk.ts does not contain tallow:cwd_changed event listener", () => {
		const sdkPath = resolve(__dirname, "../../src/sdk.ts");
		const sdkSource = readFileSync(sdkPath, "utf-8");
		// The dead listener was removed — verify it stays gone
		expect(sdkSource).not.toContain('events.on("tallow:cwd_changed"');
	});

	it("sdk.ts contains the explanatory comment about why cwd_changed is unnecessary", () => {
		const sdkPath = resolve(__dirname, "../../src/sdk.ts");
		const sdkSource = readFileSync(sdkPath, "utf-8");
		expect(sdkSource).toContain("Trust context does not need a cwd_changed event listener");
	});
});

// ════════════════════════════════════════════════════════════════
// Audit Finding 1.4: session_shutdown type safety
// ════════════════════════════════════════════════════════════════

describe("session_shutdown type safety", () => {
	const extensionsDir = resolve(__dirname, "..");

	it("no extension uses 'as never' cast for session_shutdown", () => {
		const violations: string[] = [];
		const dirs = readdirSync(extensionsDir, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith("_"))
			.map((d) => join(extensionsDir, d.name));

		for (const dir of dirs) {
			const indexPath = join(dir, "index.ts");
			if (!existsSync(indexPath)) continue;
			const source = readFileSync(indexPath, "utf-8");
			if (source.includes('session_shutdown" as never')) {
				violations.push(dir.split("/").at(-1) ?? dir);
			}
		}

		// Also check nested files (e.g. teams-tool/tools/register-extension.ts)
		for (const dir of dirs) {
			try {
				const subDirs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
				for (const sub of subDirs) {
					if (sub.name === "__tests__" || sub.name === "node_modules") continue;
					const subPath = join(dir, sub.name);
					const files = readdirSync(subPath).filter((f) => f.endsWith(".ts"));
					for (const file of files) {
						const source = readFileSync(join(subPath, file), "utf-8");
						if (source.includes('session_shutdown" as never')) {
							violations.push(`${dir.split("/").pop()}/${sub.name}/${file}`);
						}
					}
				}
			} catch {
				// not a directory with subdirs
			}
		}

		expect(violations).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════
// Audit Finding 1.5: subagent-tool has session_shutdown
// ════════════════════════════════════════════════════════════════

describe("subagent-tool session_shutdown", () => {
	it("subagent-tool/index.ts contains session_shutdown handler", () => {
		const source = readFileSync(resolve(__dirname, "../subagent-tool/index.ts"), "utf-8");
		expect(source).toContain('on("session_shutdown"');
	});
});

// ════════════════════════════════════════════════════════════════
// Tool Restriction Enforcement (--tools flag)
// ════════════════════════════════════════════════════════════════

describe("Explicit tool restriction", () => {
	it("tool_call handler blocks tools not in the allowlist", async () => {
		const blocked: string[] = [];
		const extensionFactory: ExtensionFactory = (pi: ExtensionAPI) => {
			const allowed = new Set(["read"]);
			pi.on("tool_call", async (event) => {
				if (!allowed.has(event.toolName)) {
					blocked.push(event.toolName);
					return { block: true, reason: "Not allowed" };
				}
			});
		};

		const harness = ExtensionHarness.create();
		await harness.loadExtension(extensionFactory);
		const results = await harness.fireEvent("tool_call", {
			type: "tool_call",
			toolName: "bash",
			toolCallId: "test-1",
			input: { command: "ls" },
		});
		const blockResult = results.find(
			(r) => r && typeof r === "object" && (r as { block?: boolean }).block
		);
		expect(blockResult).toBeDefined();
		expect(blocked).toContain("bash");
	});

	it("tool_call handler allows tools in the allowlist", async () => {
		const extensionFactory: ExtensionFactory = (pi: ExtensionAPI) => {
			const allowed = new Set(["read", "bash"]);
			pi.on("tool_call", async (event) => {
				if (!allowed.has(event.toolName)) {
					return { block: true, reason: "Not allowed" };
				}
			});
		};

		const harness = ExtensionHarness.create();
		await harness.loadExtension(extensionFactory);
		const results = await harness.fireEvent("tool_call", {
			type: "tool_call",
			toolName: "read",
			toolCallId: "test-2",
			input: { path: "test.txt" },
		});
		const blockResult = results.find(
			(r) => r && typeof r === "object" && (r as { block?: boolean }).block
		);
		expect(blockResult).toBeUndefined();
	});
});

// ════════════════════════════════════════════════════════════════
// session_shutdown handler fires during lifecycle
// ════════════════════════════════════════════════════════════════

describe("session_shutdown lifecycle", () => {
	it("session_shutdown handler fires when simulated", async () => {
		let shutdownFired = false;
		const extensionFactory: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.on("session_shutdown", async () => {
				shutdownFired = true;
			});
		};

		const harness = ExtensionHarness.create();
		await harness.loadExtension(extensionFactory);
		await harness.fireEvent("session_shutdown", { type: "session_shutdown" });
		expect(shutdownFired).toBe(true);
	});

	it("multiple session_shutdown handlers all fire", async () => {
		const fired: string[] = [];
		const ext1: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.on("session_shutdown", async () => {
				fired.push("ext1");
			});
		};
		const ext2: ExtensionFactory = (pi: ExtensionAPI) => {
			pi.on("session_shutdown", async () => {
				fired.push("ext2");
			});
		};

		const harness = ExtensionHarness.create();
		await harness.loadExtension(ext1);
		await harness.loadExtension(ext2);
		await harness.fireEvent("session_shutdown", { type: "session_shutdown" });
		expect(fired).toContain("ext1");
		expect(fired).toContain("ext2");
	});
});

// ════════════════════════════════════════════════════════════════
// Lazy-init circuit breaker
// ════════════════════════════════════════════════════════════════

describe("lazy-init circuit breaker", () => {
	it("createLazyInitializer exposes isPermanentlyFailed()", async () => {
		const { createLazyInitializer } = await import("../../extensions/_shared/lazy-init.js");
		const init = createLazyInitializer({
			name: "test",
			maxRetries: 1,
			initialize: async () => {
				throw new Error("always fails");
			},
		});

		expect(init.isPermanentlyFailed()).toBe(false);

		// First call fails
		try {
			await init.ensureInitialized({ trigger: "test", context: {} });
		} catch {
			// expected
		}

		// After maxRetries, permanently failed
		expect(init.isPermanentlyFailed()).toBe(true);

		// Next call rejects immediately
		try {
			await init.ensureInitialized({ trigger: "test", context: {} });
			expect(true).toBe(false); // should not reach
		} catch (e) {
			expect((e as Error).message).toContain("always fails");
		}
	});

	it("reset() clears permanent failure state", async () => {
		const { createLazyInitializer } = await import("../../extensions/_shared/lazy-init.js");
		let callCount = 0;
		const init = createLazyInitializer({
			name: "test-reset",
			maxRetries: 1,
			initialize: async () => {
				callCount++;
				if (callCount <= 1) throw new Error("fail first");
			},
		});

		try {
			await init.ensureInitialized({ trigger: "test", context: {} });
		} catch {
			// expected
		}
		expect(init.isPermanentlyFailed()).toBe(true);

		init.reset();
		expect(init.isPermanentlyFailed()).toBe(false);

		// Should succeed after reset
		await init.ensureInitialized({ trigger: "test", context: {} });
		expect(init.isInitialized()).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════
// AGENTS.md accuracy
// ════════════════════════════════════════════════════════════════

describe("AGENTS.md accuracy", () => {
	it("config.ts description does not mention cache", () => {
		const agentsMd = readFileSync(resolve(__dirname, "../../AGENTS.md"), "utf-8");
		// The cache myth was removed
		expect(agentsMd).not.toContain(".env.cache");
		expect(agentsMd).not.toContain("1h TTL");
	});

	it("TUI guidance points to the audit script and narrow keep surface", () => {
		const agentsMd = readFileSync(resolve(__dirname, "../../AGENTS.md"), "utf-8");
		expect(agentsMd).toContain("node scripts/audit-pi-tui-fork.mjs");
		expect(agentsMd).toContain("border styles");
		expect(agentsMd).toContain("editor ghost-text and change-listener APIs");
	});

	it("sdk.ts description acknowledges ~2900 lines and inline factory extensions", () => {
		const agentsMd = readFileSync(resolve(__dirname, "../../AGENTS.md"), "utf-8");
		expect(agentsMd).toContain("~2900 lines");
		expect(agentsMd).toContain("inline factory extensions");
	});
});

// ════════════════════════════════════════════════════════════════
// Every extension has tests
// ════════════════════════════════════════════════════════════════

describe("Extension test coverage completeness", () => {
	it("all non-utility extension directories have __tests__/", () => {
		const skip = new Set(["__integration__", "_shared", "_icons"]);
		const dirs = readdirSync(resolve(__dirname, ".."), { withFileTypes: true })
			.filter((d) => d.isDirectory() && !skip.has(d.name))
			.map((d) => d.name);

		const untested = dirs.filter(
			(name) => !existsSync(join(resolve(__dirname, ".."), name, "__tests__"))
		);

		expect(untested).toEqual([]);
	});
});
