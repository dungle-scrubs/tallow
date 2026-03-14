/** Runtime timer interface used by deterministic test schedulers. */
export interface RuntimeTimerScheduler {
	readonly now: () => number;
	readonly setInterval: (callback: () => void, intervalMs: number) => unknown;
	readonly clearInterval: (handle: unknown) => void;
	readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
	readonly clearTimeout: (handle: unknown) => void;
}

interface ScheduledTask {
	readonly callback: () => void;
	readonly delayMs: number;
	readonly id: number;
	readonly type: "interval" | "timeout";
	runAt: number;
}

/**
 * Deterministic in-memory timer scheduler for tests.
 *
 * Timers only run when the test advances time explicitly via {@link advanceBy}.
 */
export class ManualTimerScheduler {
	readonly runtime: RuntimeTimerScheduler;

	private nowMs = 0;
	private nextId = 1;
	private readonly tasks = new Map<number, ScheduledTask>();

	constructor() {
		this.runtime = {
			now: () => this.nowMs,
			setInterval: (callback, intervalMs) => this.schedule("interval", callback, intervalMs),
			clearInterval: (handle) => this.clear(handle),
			setTimeout: (callback, delayMs) => this.schedule("timeout", callback, delayMs),
			clearTimeout: (handle) => this.clear(handle),
		};
	}

	/**
	 * Advances the scheduler clock and runs any timers due within the interval.
	 *
	 * @param milliseconds - Virtual time to advance
	 * @returns Nothing
	 */
	advanceBy(milliseconds: number): void {
		const targetTime = this.nowMs + Math.max(0, milliseconds);

		while (true) {
			const nextTask = this.findNextDueTask(targetTime);
			if (!nextTask) {
				break;
			}

			this.nowMs = nextTask.runAt;

			if (nextTask.type === "timeout") {
				this.tasks.delete(nextTask.id);
				nextTask.callback();
				continue;
			}

			nextTask.runAt += nextTask.delayMs;
			nextTask.callback();
		}

		this.nowMs = targetTime;
	}

	/**
	 * Returns the number of currently scheduled timers.
	 *
	 * @returns Count of pending timers
	 */
	getPendingTaskCount(): number {
		return this.tasks.size;
	}

	/**
	 * Removes a scheduled timer by handle.
	 *
	 * @param handle - Timer handle returned by the runtime scheduler
	 * @returns Nothing
	 */
	private clear(handle: unknown): void {
		if (typeof handle !== "number") {
			return;
		}

		this.tasks.delete(handle);
	}

	/**
	 * Returns the next task due on or before the target time.
	 *
	 * @param targetTime - Upper bound for eligible tasks
	 * @returns Earliest due task, if any
	 */
	private findNextDueTask(targetTime: number): ScheduledTask | undefined {
		let nextTask: ScheduledTask | undefined;
		for (const task of this.tasks.values()) {
			if (task.runAt > targetTime) {
				continue;
			}
			if (!nextTask || task.runAt < nextTask.runAt || task.id < nextTask.id) {
				nextTask = task;
			}
		}
		return nextTask;
	}

	/**
	 * Registers a timeout or interval task.
	 *
	 * @param type - Timer kind
	 * @param callback - Callback to run when due
	 * @param delayMs - Delay before the timer becomes due
	 * @returns Numeric timer handle
	 */
	private schedule(type: "interval" | "timeout", callback: () => void, delayMs: number): number {
		const id = this.nextId++;
		this.tasks.set(id, {
			callback,
			delayMs: Math.max(0, delayMs),
			id,
			type,
			runAt: this.nowMs + Math.max(0, delayMs),
		});
		return id;
	}
}
