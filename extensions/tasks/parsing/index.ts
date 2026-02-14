/**
 * Pure text-parsing utilities for the tasks extension.
 *
 * Extracts task titles from markdown-style lists and detects completion markers
 * in assistant output. All functions are stateless and side-effect-free.
 */

import type { Task } from "../state/index.js";

/**
 * Extract task titles from markdown-style task list text.
 *
 * Recognises three formats:
 *  - Numbered lists: `1. task`, `1) task`
 *  - Checkbox lists: `- [ ] task`, `- [x] task`, `* [ ] task`
 *  - Header blocks: lines following `Tasks:`, `TODO:`, `Steps:` headers
 *
 * Items shorter than 4 characters and numbered items starting with `[` are
 * rejected.  Duplicates are removed.
 *
 * @param text - Text containing task list items
 * @returns De-duplicated array of task title strings
 */
export function _extractTasksFromText(text: string): string[] {
	const tasks: string[] = [];

	// Match numbered lists: "1. task", "1) task"
	const numberedRegex = /^\s*(\d+)[.)]\s+(.+)$/gm;
	for (const match of text.matchAll(numberedRegex)) {
		const task = match[2].trim();
		if (task && !task.startsWith("[") && task.length > 3) {
			tasks.push(task);
		}
	}

	// Match checkbox lists: "- [ ] task", "- [x] task", "* [ ] task"
	const checkboxRegex = /^\s*[-*]\s*\[[ x]\]\s+(.+)$/gim;
	for (const match of text.matchAll(checkboxRegex)) {
		const task = match[1].trim();
		if (task && task.length > 3) {
			tasks.push(task);
		}
	}

	// Match "Task:" or "TODO:" headers followed by items
	const taskHeaderRegex = /(?:Tasks?|TODO|To-?do|Steps?):\s*\n((?:\s*[-*\d.]+.+\n?)+)/gi;
	for (const match of text.matchAll(taskHeaderRegex)) {
		const block = match[1];
		const items = block.split("\n").filter((line) => line.trim());
		for (const item of items) {
			const cleaned = item.replace(/^\s*[-*\d.)]+\s*/, "").trim();
			if (cleaned && cleaned.length > 3) {
				tasks.push(cleaned);
			}
		}
	}

	return [...new Set(tasks)]; // Dedupe
}

/**
 * Finds tasks marked as completed in the given text.
 *
 * Scans for `[DONE: #id]`, `[COMPLETE: #id]`, `completed: #id`, and
 * subject-prefix variants.  Matching is conservative to avoid false positives
 * from generic prose.
 *
 * @param text - Text to search for completion markers
 * @param tasks - Tasks to check for completion
 * @returns Array of completed task IDs
 */
export function findCompletedTasks(text: string, tasks: Task[]): string[] {
	const completed: string[] = [];

	for (const task of tasks) {
		const subjectPrefix = escapeRegex(task.subject.substring(0, 50));
		const patterns = [
			new RegExp(`\\[(?:DONE|COMPLETE):?\\s*#?${task.id}\\]`, "i"),
			new RegExp(`completed:\\s*#?${task.id}(?:\\b|\\s|$)`, "i"),
			new RegExp(`\\[(?:DONE|COMPLETE)\\]\\s*(?:completed:\\s*)?${subjectPrefix}`, "i"),
			new RegExp(`completed:\\s*${subjectPrefix}`, "i"),
		];

		for (const pattern of patterns) {
			if (pattern.test(text)) {
				completed.push(task.id);
				break;
			}
		}
	}

	return completed;
}

/**
 * Escapes special regex characters in a string.
 *
 * @param str - String to escape
 * @returns Escaped string safe for use in `new RegExp()`
 */
export function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
