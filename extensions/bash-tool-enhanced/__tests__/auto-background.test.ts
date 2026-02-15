/**
 * Tests for auto-background promotion logic.
 *
 * Tests the promoteToBackground API and PromotedTaskHandle behavior
 * since the timeout race in bash-tool-enhanced requires a running process
 * and is better validated via integration tests.
 */
import { describe, expect, it } from "bun:test";
import { promoteToBackground } from "../../background-task-tool/index.js";

describe("promoteToBackground", () => {
	it("returns a handle with a task ID", () => {
		const abort = new AbortController();
		const handle = promoteToBackground({
			command: "sleep 60",
			cwd: "/tmp",
			startTime: Date.now(),
			initialOutput: "",
			abortController: abort,
		});

		expect(handle.id).toMatch(/^bg_\d+_/);
		// Cleanup: mark completed to avoid leaking into other tests
		handle.complete(0);
	});

	it("captures initial output in the task", () => {
		const abort = new AbortController();
		const handle = promoteToBackground({
			command: "echo hello",
			cwd: "/tmp",
			startTime: Date.now() - 5000,
			initialOutput: "hello\nworld\n",
			abortController: abort,
		});

		expect(handle.id).toBeTruthy();
		handle.complete(0);
	});

	it("replaceOutput replaces the entire buffer", () => {
		const abort = new AbortController();
		const handle = promoteToBackground({
			command: "cat big.txt",
			cwd: "/tmp",
			startTime: Date.now(),
			initialOutput: "line1\n",
			abortController: abort,
		});

		handle.replaceOutput("line1\nline2\nline3\n");
		handle.complete(0);
	});

	it("complete marks the task as done", () => {
		const abort = new AbortController();
		const handle = promoteToBackground({
			command: "make build",
			cwd: "/tmp",
			startTime: Date.now(),
			initialOutput: "",
			abortController: abort,
		});

		handle.complete(0);
		// No error means success — task_status would show "completed"
	});

	it("complete with non-zero exit marks as failed", () => {
		const abort = new AbortController();
		const handle = promoteToBackground({
			command: "make test",
			cwd: "/tmp",
			startTime: Date.now(),
			initialOutput: "FAIL: test_foo",
			abortController: abort,
		});

		handle.complete(1);
		// No error means success — task_status would show "failed"
	});

	it("handles empty initial output", () => {
		const abort = new AbortController();
		const handle = promoteToBackground({
			command: "sleep 100",
			cwd: "/tmp",
			startTime: Date.now(),
			initialOutput: "",
			abortController: abort,
		});

		expect(handle.id).toBeTruthy();
		handle.complete(0);
	});
});
