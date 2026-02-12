import type { Component } from "../tui.js";
import { applyBackgroundToLine, visibleWidth } from "../utils.js";

type RenderCache = {
	childLines: string[];
	width: number;
	bgSample: string | undefined;
	lines: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	children: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private bgFn?: (text: string) => string;

	/** Optional badge rendered in the lower-right corner of the box. */
	private _badge: string | null = null;

	// Cache for rendered output
	private cache?: RenderCache;

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	/**
	 * Get the current badge text.
	 *
	 * @returns Badge string or null if no badge is set
	 */
	get badge(): string | null {
		return this._badge;
	}

	/**
	 * Set a badge to render in the lower-right corner of the box.
	 * Pass null to clear. Does NOT invalidate content cache — the badge
	 * is composited on top of cached content at render time, so badge
	 * changes don't trigger expensive re-renders of parent components.
	 *
	 * @param value - Badge text (may include ANSI codes) or null
	 */
	set badge(value: string | null) {
		this._badge = value;
	}

	addChild(component: Component): void {
		this.children.push(component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
			this.invalidateCache();
		}
	}

	clear(): void {
		this.children = [];
		this.invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		// Don't invalidate here - we'll detect bgFn changes by sampling output
	}

	private invalidateCache(): void {
		this.cache = undefined;
	}

	private matchCache(width: number, childLines: string[], bgSample: string | undefined): boolean {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		if (this.children.length === 0) {
			return [];
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const leftPad = " ".repeat(this.paddingX);

		// Render all children
		const childLines: string[] = [];
		for (const child of this.children) {
			const lines = child.render(contentWidth);
			for (const line of lines) {
				childLines.push(leftPad + line);
			}
		}

		if (childLines.length === 0) {
			return [];
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;

		// Check cache validity (badge excluded — applied on top below)
		if (!this.matchCache(width, childLines, bgSample)) {
			// Apply background and padding
			const result: string[] = [];

			// Top padding
			for (let i = 0; i < this.paddingY; i++) {
				result.push(this.applyBg("", width));
			}

			// Content
			for (const line of childLines) {
				result.push(this.applyBg(line, width));
			}

			// Bottom padding
			for (let i = 0; i < this.paddingY; i++) {
				result.push(this.applyBg("", width));
			}

			// Update cache (base content only, no badge)
			this.cache = { childLines, width, bgSample, lines: result };
		}

		return this.applyBadge(this.cache!.lines, width);
	}

	/**
	 * Composite the badge onto the last line of rendered output.
	 * Returns the original array if no badge is set; clones and
	 * modifies the last element otherwise (avoids mutating cache).
	 *
	 * @param lines - Base rendered lines (from cache)
	 * @param width - Full render width
	 * @returns Lines with badge composited, or original if no badge
	 */
	private applyBadge(lines: string[], width: number): string[] {
		if (this._badge == null || lines.length === 0) return lines;

		const badgeWidth = visibleWidth(this._badge);
		const insertCol = width - badgeWidth - this.paddingX;
		if (insertCol < this.paddingX) return lines;

		// Clone to avoid mutating cached lines
		const result = [...lines];
		const lastIdx = result.length - 1;
		const line = " ".repeat(insertCol) + this._badge + " ".repeat(this.paddingX);
		result[lastIdx] = this.applyBg(line, width);
		return result;
	}

	private applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + " ".repeat(padNeeded);

		if (this.bgFn) {
			return applyBackgroundToLine(padded, width, this.bgFn);
		}
		return padded;
	}
}
