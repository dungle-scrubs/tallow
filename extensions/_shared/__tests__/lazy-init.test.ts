import { describe, expect, test } from "bun:test";
import { createLazyInitializer } from "../lazy-init.js";

describe("createLazyInitializer", () => {
	test("runs initializer only once after successful completion", async () => {
		const triggers: string[] = [];
		const lazy = createLazyInitializer<{ cwd: string }>({
			name: "test",
			async initialize(input) {
				triggers.push(input.trigger);
			},
		});

		await lazy.ensureInitialized({ trigger: "before_agent_start", context: { cwd: "/tmp" } });
		await lazy.ensureInitialized({ trigger: "input", context: { cwd: "/tmp" } });

		expect(triggers).toEqual(["before_agent_start"]);
		expect(lazy.isInitialized()).toBe(true);
	});

	test("dedupes concurrent initialization calls", async () => {
		let initializeCalls = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const lazy = createLazyInitializer<{ cwd: string }>({
			name: "test",
			async initialize() {
				initializeCalls++;
				await gate;
			},
		});

		const first = lazy.ensureInitialized({ trigger: "before_agent_start", context: { cwd: "/a" } });
		const second = lazy.ensureInitialized({ trigger: "command", context: { cwd: "/b" } });

		expect(initializeCalls).toBe(1);
		release();
		await Promise.all([first, second]);

		expect(initializeCalls).toBe(1);
		expect(lazy.isInitialized()).toBe(true);
	});

	test("retries after initialization failure", async () => {
		let attempts = 0;
		const lazy = createLazyInitializer<{ cwd: string }>({
			name: "test",
			async initialize() {
				attempts++;
				if (attempts === 1) {
					throw new Error("boom");
				}
			},
		});

		await expect(
			lazy.ensureInitialized({ trigger: "before_agent_start", context: { cwd: "/tmp" } })
		).rejects.toThrow("boom");
		expect(lazy.isInitialized()).toBe(false);

		await lazy.ensureInitialized({ trigger: "before_agent_start", context: { cwd: "/tmp" } });
		expect(attempts).toBe(2);
		expect(lazy.isInitialized()).toBe(true);
	});

	test("reset forces the next call to reinitialize", async () => {
		let attempts = 0;
		const lazy = createLazyInitializer<{ cwd: string }>({
			name: "test",
			async initialize() {
				attempts++;
			},
		});

		await lazy.ensureInitialized({ trigger: "before_agent_start", context: { cwd: "/tmp" } });
		lazy.reset();
		await lazy.ensureInitialized({ trigger: "input", context: { cwd: "/tmp" } });

		expect(attempts).toBe(2);
	});
});
