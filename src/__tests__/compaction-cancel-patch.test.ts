import { describe, expect, it } from "bun:test";
import { patchAgentSessionCompactionCancel } from "../compaction-cancel-patch.js";

/** Fake prototype matching the patch's expected shape. */
class FakeAgentSession {
	abortCompactionCalls = 0;
	newSessionCalls = 0;
	switchSessionCalls = 0;
	callOrder: string[] = [];

	/**
	 * Stub abortCompaction that records invocations.
	 *
	 * @returns Nothing
	 */
	abortCompaction(): void {
		this.abortCompactionCalls++;
		this.callOrder.push("abortCompaction");
	}

	/**
	 * Stub newSession that records invocations.
	 *
	 * @param _options - Ignored options
	 * @returns Always resolves true
	 */
	async newSession(_options?: unknown): Promise<boolean> {
		this.newSessionCalls++;
		this.callOrder.push("newSession");
		return true;
	}

	/**
	 * Stub switchSession that records invocations.
	 *
	 * @param _sessionPath - Ignored session path
	 * @returns Always resolves true
	 */
	async switchSession(_sessionPath: string): Promise<boolean> {
		this.switchSessionCalls++;
		this.callOrder.push("switchSession");
		return true;
	}
}

describe("patchAgentSessionCompactionCancel", () => {
	it("calls abortCompaction before original newSession", async () => {
		const proto = new FakeAgentSession();
		patchAgentSessionCompactionCancel(proto);

		await proto.newSession();

		expect(proto.abortCompactionCalls).toBe(1);
		expect(proto.newSessionCalls).toBe(1);
		expect(proto.callOrder).toEqual(["abortCompaction", "newSession"]);
	});

	it("calls abortCompaction before original switchSession", async () => {
		const proto = new FakeAgentSession();
		patchAgentSessionCompactionCancel(proto);

		await proto.switchSession("/tmp/session");

		expect(proto.abortCompactionCalls).toBe(1);
		expect(proto.switchSessionCalls).toBe(1);
		expect(proto.callOrder).toEqual(["abortCompaction", "switchSession"]);
	});

	it("is idempotent — does not double-wrap", async () => {
		const proto = new FakeAgentSession();
		patchAgentSessionCompactionCancel(proto);
		patchAgentSessionCompactionCancel(proto);
		patchAgentSessionCompactionCancel(proto);

		await proto.newSession();
		await proto.switchSession("/tmp/s");

		// Each method called once → abortCompaction called once per method call = 2 total
		expect(proto.abortCompactionCalls).toBe(2);
		expect(proto.newSessionCalls).toBe(1);
		expect(proto.switchSessionCalls).toBe(1);
	});

	it("prevents race-style mutation when abortCompaction cancels delayed side-effect", async () => {
		let corrupted = false;
		let abortCalled = false;

		const proto = {
			abortCompaction(): void {
				abortCalled = true;
			},
			async newSession(): Promise<boolean> {
				// Simulate a delayed compaction side-effect that would corrupt
				// state unless abortCompaction was called first.
				await new Promise((resolve) => setTimeout(resolve, 10));
				if (!abortCalled) {
					corrupted = true;
				}
				return true;
			},
			async switchSession(_path: string): Promise<boolean> {
				return true;
			},
		};

		patchAgentSessionCompactionCancel(proto);
		await proto.newSession();

		expect(corrupted).toBe(false);
		expect(abortCalled).toBe(true);
	});

	it("preserves return values from original methods", async () => {
		const proto = {
			abortCompaction(): void {},
			async newSession(): Promise<boolean> {
				return true;
			},
			async switchSession(_path: string): Promise<boolean> {
				return false;
			},
		};

		patchAgentSessionCompactionCancel(proto);

		expect(await proto.newSession()).toBe(true);
		expect(await proto.switchSession("/tmp/s")).toBe(false);
	});

	it("passes arguments through to original methods", async () => {
		let capturedOptions: unknown;
		let capturedPath: string | undefined;

		const proto = {
			abortCompaction(): void {},
			async newSession(options?: unknown): Promise<boolean> {
				capturedOptions = options;
				return true;
			},
			async switchSession(path: string): Promise<boolean> {
				capturedPath = path;
				return true;
			},
		};

		patchAgentSessionCompactionCancel(proto);

		const opts = { parentSession: "/tmp/parent" };
		await proto.newSession(opts);
		await proto.switchSession("/tmp/target");

		expect(capturedOptions).toBe(opts);
		expect(capturedPath).toBe("/tmp/target");
	});

	it("tolerates missing abortCompaction gracefully", async () => {
		const proto = {
			async newSession(): Promise<boolean> {
				return true;
			},
			async switchSession(_path: string): Promise<boolean> {
				return true;
			},
		};

		patchAgentSessionCompactionCancel(proto);

		// Should not throw even though abortCompaction is missing
		expect(await proto.newSession()).toBe(true);
		expect(await proto.switchSession("/x")).toBe(true);
	});
});
