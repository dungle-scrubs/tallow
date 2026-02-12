/**
 * Box component with configurable border style (sharp, rounded, flat).
 *
 * Wraps child content lines in a full border with optional title,
 * padding, and background fill.
 *
 * @module
 */

import { type BorderStyle, defaultBorderStyle } from "../border-styles.js";
import { visibleWidth } from "../utils.js";
import { Text } from "./text.js";

/** Configuration for a BorderedBox. */
export interface BorderedBoxOptions {
	/** Border character set (defaults to global defaultBorderStyle). */
	borderStyle?: BorderStyle;
	/** Title rendered in the top border (optional). */
	title?: string;
	/** Horizontal padding inside the border (default: 1). */
	paddingX?: number;
	/** Color function applied to border characters. */
	borderColorFn?: (str: string) => string;
	/** Color function applied to the title. */
	titleColorFn?: (str: string) => string;
}

/**
 * Renders content inside a bordered box.
 *
 * Usage:
 * ```typescript
 * const box = new BorderedBox(["line 1", "line 2"], {
 *   borderStyle: ROUNDED,
 *   title: "Output",
 * });
 * const lines = box.render(80);
 * ```
 */
export class BorderedBox extends Text {
	private contentLines: string[];
	private options: BorderedBoxOptions;

	/**
	 * @param contentLines - Pre-rendered content lines to wrap
	 * @param options - Border style, title, padding, color functions
	 */
	constructor(contentLines: string[], options: BorderedBoxOptions = {}) {
		super("", contentLines.length + 2, 0);
		this.contentLines = contentLines;
		this.options = options;
	}

	/**
	 * Render the bordered box to an array of terminal lines.
	 *
	 * @param width - Available terminal width
	 * @returns Array of rendered lines including top/bottom borders
	 */
	render(width: number): string[] {
		const style = this.options.borderStyle ?? defaultBorderStyle;
		const padX = this.options.paddingX ?? 1;
		const colorBorder = this.options.borderColorFn ?? ((s: string) => s);
		const colorTitle = this.options.titleColorFn ?? ((s: string) => s);

		const innerWidth = width - 2 - padX * 2; // borders + padding
		if (innerWidth < 1) return this.contentLines;

		const pad = " ".repeat(padX);

		// Top border with optional title
		let topBar: string;
		if (this.options.title) {
			const titleStr = ` ${colorTitle(this.options.title)} `;
			const titleVisLen = visibleWidth(titleStr);
			const remaining = width - 2 - titleVisLen;
			const rightFill = Math.max(0, remaining);
			topBar =
				colorBorder(style.topLeft) +
				colorBorder(style.horizontal) +
				titleStr +
				colorBorder(style.horizontal.repeat(Math.max(0, rightFill))) +
				colorBorder(style.topRight);
		} else {
			topBar =
				colorBorder(style.topLeft) +
				colorBorder(style.horizontal.repeat(width - 2)) +
				colorBorder(style.topRight);
		}

		// Content lines with side borders
		const bodyLines = this.contentLines.map((line) => {
			const lineWidth = visibleWidth(line);
			const fill = Math.max(0, innerWidth - lineWidth);
			return (
				colorBorder(style.vertical) +
				pad +
				line +
				" ".repeat(fill) +
				pad +
				colorBorder(style.vertical)
			);
		});

		// Bottom border
		const bottomBar =
			colorBorder(style.bottomLeft) +
			colorBorder(style.horizontal.repeat(width - 2)) +
			colorBorder(style.bottomRight);

		return [topBar, ...bodyLines, bottomBar];
	}
}
