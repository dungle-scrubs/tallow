/**
 * Tests for TaskListStore: file-backed persistence, locking, atomic writes,
 * corruption tolerance, and session-only mode.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Task, TaskListStore } from "../state/index.js";

/**
 * Create a minimal task for store tests.
 *
 * @param id - Task ID
 * @param subject - Task subject
 * @returns Task object
 */
function makeTask(id: string, subject = "Test task"): Task {
	return {
		id,
		subject,
		status: "pending",
		blocks: [],
		blockedBy: [],
		comments: [],
		createdAt: Date.now(),
	};
}

/**
 * Create a file-backed store with a unique team name and return cleanup helpers.
 * Avoids repetitive non-null assertions across tests.
 *
 * @param label - Short label for uniqueness
 * @returns Store, its guaranteed path, parent team dir, and cleanup function
 */
function createTestStore(label: string): {
	store: TaskListStore;
	dir: string;
	teamDir: string;
	cleanup: () => void;
} {
	const teamName = `${label}-${Date.now()}`;
	const store = new TaskListStore(teamName);
	const dir = store.path as string;
	const teamDir = join(dir, "..");
	return {
		store,
		dir,
		teamDir,
		cleanup: () => {
			store.deleteAll();
			store.close();
			rmSync(teamDir, { recursive: true, force: true });
		},
	};
}

// ── Session-only mode (null team) ────────────────────────────────────────────

describe("TaskListStore session-only mode", () => {
	it("reports isShared=false and path=null", () => {
		const store = new TaskListStore(null);
		expect(store.isShared).toBe(false);
		expect(store.path).toBeNull();
	});

	it("loadAll returns null", () => {
		const store = new TaskListStore(null);
		expect(store.loadAll()).toBeNull();
	});

	it("saveTask and deleteTask are no-ops", () => {
		const store = new TaskListStore(null);
		store.saveTask(makeTask("1"));
		store.deleteTask("1");
		// No error thrown
	});

	it("lock returns a no-op unlock function", () => {
		const store = new TaskListStore(null);
		const unlock = store.lock();
		expect(typeof unlock).toBe("function");
		unlock(); // no-op, no error
	});

	it("watch and close don't throw", () => {
		const store = new TaskListStore(null);
		store.watch(() => {
			throw new Error("Should never fire");
		});
		store.close();
	});

	it("deleteAll is a no-op", () => {
		const store = new TaskListStore(null);
		store.deleteAll(); // no error
	});
});

// ── File-backed mode ─────────────────────────────────────────────────────────

describe("TaskListStore file-backed mode", () => {
	const stores: Array<{ cleanup: () => void }> = [];

	afterEach(() => {
		for (const s of stores) {
			try {
				s.cleanup();
			} catch {
				// best-effort
			}
		}
		stores.length = 0;
	});

	it("creates the task directory on construction", () => {
		const ctx = createTestStore("construct");
		stores.push(ctx);

		expect(ctx.store.isShared).toBe(true);
		expect(existsSync(ctx.dir)).toBe(true);
	});

	it("saveTask persists and loadAll retrieves", () => {
		const ctx = createTestStore("persist");
		stores.push(ctx);

		ctx.store.saveTask(makeTask("1", "Persist me"));

		const loaded = ctx.store.loadAll();
		expect(loaded).not.toBeNull();
		expect(loaded).toHaveLength(1);
		expect(loaded?.[0].id).toBe("1");
		expect(loaded?.[0].subject).toBe("Persist me");
	});

	it("deleteTask removes the file", () => {
		const ctx = createTestStore("delete");
		stores.push(ctx);

		ctx.store.saveTask(makeTask("1"));
		expect(ctx.store.loadAll()).toHaveLength(1);

		ctx.store.deleteTask("1");
		expect(ctx.store.loadAll()).toHaveLength(0);
	});

	it("deleteAll clears all task files", () => {
		const ctx = createTestStore("delall");
		stores.push(ctx);

		ctx.store.saveTask(makeTask("1"));
		ctx.store.saveTask(makeTask("2"));
		ctx.store.saveTask(makeTask("3"));
		expect(ctx.store.loadAll()).toHaveLength(3);

		ctx.store.deleteAll();
		expect(ctx.store.loadAll()).toHaveLength(0);
	});

	it("sorts tasks by numeric ID", () => {
		const ctx = createTestStore("sort");
		stores.push(ctx);

		ctx.store.saveTask(makeTask("3", "Third"));
		ctx.store.saveTask(makeTask("1", "First"));
		ctx.store.saveTask(makeTask("2", "Second"));

		const loaded = ctx.store.loadAll() ?? [];
		expect(loaded[0].id).toBe("1");
		expect(loaded[1].id).toBe("2");
		expect(loaded[2].id).toBe("3");
	});

	it("skips corrupt JSON files in loadAll", () => {
		const ctx = createTestStore("corrupt");
		stores.push(ctx);

		ctx.store.saveTask(makeTask("1", "Valid"));
		writeFileSync(join(ctx.dir, "2.json"), "{invalid json!!!", "utf-8");

		const loaded = ctx.store.loadAll() ?? [];
		expect(loaded).toHaveLength(1);
		expect(loaded[0].id).toBe("1");
	});

	it("lock/unlock cycle completes without error", () => {
		const ctx = createTestStore("lock");
		stores.push(ctx);

		const unlock = ctx.store.lock();
		expect(typeof unlock).toBe("function");
		unlock();
	});

	it("sanitizes special characters in team name", () => {
		const store = new TaskListStore("my team/with:special<chars>");
		const path = store.path ?? "";
		stores.push({
			cleanup: () => {
				store.deleteAll();
				store.close();
				rmSync(join(path, ".."), { recursive: true, force: true });
			},
		});

		expect(path).not.toContain("/with:");
		expect(path).toContain("my_team_with_special_chars_");
	});

	it("migrates old schema: title → subject, dependencies → blockedBy", () => {
		const ctx = createTestStore("migrate");
		stores.push(ctx);

		const oldTask = {
			id: "1",
			title: "Old format",
			status: "pending",
			dependencies: ["2"],
		};
		writeFileSync(join(ctx.dir, "1.json"), JSON.stringify(oldTask), "utf-8");

		const loaded = ctx.store.loadAll() ?? [];
		expect(loaded).toHaveLength(1);
		expect(loaded[0].subject).toBe("Old format");
		expect(loaded[0].blockedBy).toEqual(["2"]);
	});

	it("loadAll returns empty array for empty directory", () => {
		const ctx = createTestStore("empty");
		stores.push(ctx);

		const loaded = ctx.store.loadAll() ?? [];
		expect(loaded).toEqual([]);
	});
});
