/**
 * Image component for the TUI.
 * Renders images via Kitty/iTerm2 protocols with optional border framing.
 * Caps portrait images to a sensible height and prevents small-image upscaling.
 *
 * @module
 */

import { type BorderStyle, ROUNDED } from "../border-styles.js";
import {
	getCapabilities,
	getImageDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
} from "../terminal-image.js";
import type { Component } from "../tui.js";
import { hyperlink } from "../utils.js";

/**
 * Pending file path for the next Image instance.
 * Set by external code (e.g. a tool_result hook) before Image construction.
 * Consumed once by the next Image constructor, then cleared.
 */
let pendingFilePath: string | undefined;

/**
 * Set the file path for the next Image instance to be constructed.
 * Called before Image creation so the component can render a clickable link.
 *
 * @param path - Absolute file path, or undefined to clear
 */
export function setNextImageFilePath(path: string | undefined): void {
	pendingFilePath = path;
}

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/** Kitty image ID. If provided, reuses this ID (for animations/updates). */
	imageId?: number;
	/** Show a border around the image. Default: true. */
	border?: boolean;
	/** Border style. Default: ROUNDED. */
	borderStyle?: BorderStyle;
	/** Color function for border characters. */
	borderColorFn?: (str: string) => string;
	/** Absolute file path — enables a clickable OSC 8 file:// link below the image. */
	filePath?: string;
}

/** Default max image height in terminal rows (~half a typical 50-row terminal). */
const DEFAULT_MAX_HEIGHT_CELLS = 25;

/** Border overhead: │ + space on each side = 4 columns. */
const BORDER_OVERHEAD = 4;

/**
 * TUI component that renders an inline image using terminal graphics protocols.
 * Falls back to a text placeholder when the terminal lacks image support.
 *
 * Features:
 * - Portrait images capped to ~25 rows by default (configurable via maxHeightCells)
 * - Small images not upscaled beyond native pixel width
 * - Rounded border frame by default (configurable or disableable)
 * - Kitty warping fix: omits r= param so terminal auto-calculates rows
 */
export class Image implements Component {
	private base64Data: string;
	private mimeType: string;
	private dimensions: ImageDimensions;
	private theme: ImageTheme;
	private options: ImageOptions;
	private imageId?: number;

	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions
	) {
		this.base64Data = base64Data;
		this.mimeType = mimeType;
		this.theme = theme;
		this.options = options;
		this.dimensions = dimensions ||
			getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.imageId = options.imageId;

		// Auto-consume pending file path if not explicitly provided
		if (!this.options.filePath && pendingFilePath) {
			this.options = { ...this.options, filePath: pendingFilePath };
			pendingFilePath = undefined;
		}
	}

	/**
	 * Get the Kitty image ID used by this image (if any).
	 * @returns Image ID or undefined
	 */
	getImageId(): number | undefined {
		return this.imageId;
	}

	/** Clears cached render output so the next render() recomputes. */
	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	/**
	 * Render the image into terminal lines.
	 *
	 * @param width - Available terminal width in columns
	 * @returns Array of strings (lines) for the TUI to output
	 */
	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const showBorder = this.options.border === true;
		const borderCols = showBorder ? BORDER_OVERHEAD : 0;
		const maxWidth = Math.min(width - 2, this.options.maxWidthCells ?? width - 2) - borderCols;
		const maxHeight = this.options.maxHeightCells ?? DEFAULT_MAX_HEIGHT_CELLS;

		const caps = getCapabilities();
		let lines: string[];

		if (caps.images) {
			const result = renderImage(this.base64Data, this.dimensions, {
				maxWidthCells: maxWidth,
				maxHeightCells: maxHeight,
				imageId: this.imageId,
			});

			if (result) {
				if (result.imageId) {
					this.imageId = result.imageId;
				}

				lines = showBorder
					? this.buildBorderedImage(result.sequence, result.rows, result.columns)
					: this.buildUnborderedImage(result.sequence, result.rows, result.columns);
			} else {
				lines = this.buildFallback(showBorder);
			}
		} else {
			lines = this.buildFallback(showBorder);
		}

		this.cachedLines = lines;
		this.cachedWidth = width;

		return lines;
	}

	/**
	 * Wraps visible text in an OSC 8 file:// hyperlink if filePath is set.
	 * Returns the text unchanged when no filePath is configured.
	 *
	 * @param text - Visible content to wrap (spaces, border chars, etc.)
	 * @returns Text optionally wrapped in OSC 8 escape sequences
	 */
	private wrapFileLink(text: string): string {
		if (!this.options.filePath) return text;
		return hyperlink(`file://${encodeURI(this.options.filePath)}`, text);
	}

	/**
	 * Builds image output without a border (original behavior).
	 * First N-1 lines are filled with OSC 8–wrapped spaces (when filePath
	 * is set) so the image area is a clickable link in the text layer.
	 * Last line moves cursor up and outputs the image escape sequence.
	 *
	 * @param sequence - Terminal escape sequence for the image
	 * @param rows - Number of terminal rows the image occupies
	 * @param columns - Number of terminal columns the image occupies
	 * @returns Lines array for the TUI
	 */
	private buildUnborderedImage(sequence: string, rows: number, columns: number): string[] {
		const lines: string[] = [];
		const filler = this.wrapFileLink(" ".repeat(columns));
		for (let i = 0; i < rows - 1; i++) {
			lines.push(filler);
		}
		const moveUp = rows > 1 ? `\x1b[${rows - 1}A` : "";
		lines.push(`${this.wrapFileLink(" ".repeat(columns))}${moveUp}\x1b[${columns}D${sequence}`);
		return lines;
	}

	/**
	 * Builds image output wrapped in a border.
	 * Border characters occupy the text layer; the image fills the inner
	 * cell range via the graphics layer (Kitty/iTerm2).
	 *
	 * The last content line outputs a full bordered row (text layer), then
	 * repositions the cursor back to the first content row and places the
	 * image sequence. The graphics layer draws over the inner spaces while
	 * border characters at the edges remain visible.
	 *
	 * @param sequence - Terminal escape sequence for the image
	 * @param rows - Number of terminal rows the image occupies
	 * @param columns - Number of terminal columns the image occupies
	 * @returns Lines array for the TUI
	 */
	private buildBorderedImage(sequence: string, rows: number, columns: number): string[] {
		const style = this.options.borderStyle ?? ROUNDED;
		const colorFn = this.options.borderColorFn ?? ((s: string) => s);

		const innerWidth = columns;
		const totalWidth = innerWidth + BORDER_OVERHEAD;

		const top = colorFn(style.topLeft + style.horizontal.repeat(totalWidth - 2) + style.topRight);
		const bottom = colorFn(
			style.bottomLeft + style.horizontal.repeat(totalWidth - 2) + style.bottomRight
		);
		const leftBorder = `${colorFn(style.vertical)} `;
		const rightBorder = ` ${colorFn(style.vertical)}`;
		const emptyInner = this.wrapFileLink(" ".repeat(innerWidth));
		const borderedLine = leftBorder + emptyInner + rightBorder;

		const lines: string[] = [top];

		// Bordered empty lines — image fills the inner area via the graphics layer
		for (let i = 0; i < rows - 1; i++) {
			lines.push(borderedLine);
		}

		// Last content line: full bordered text, then reposition cursor for image placement.
		// CUU (cursor up) + CUB (cursor backward) positions to column 2 of the first content row.
		const moveUp = rows > 1 ? `\x1b[${rows - 1}A` : "";
		const moveToImageStart = `\x1b[${totalWidth - 2}D`;
		lines.push(borderedLine + moveUp + moveToImageStart + sequence);

		lines.push(bottom);

		return lines;
	}

	/**
	 * Builds fallback text when the terminal doesn't support images.
	 * Optionally wrapped in a border for visual consistency.
	 *
	 * @param showBorder - Whether to wrap the fallback in a border
	 * @returns Lines array for the TUI
	 */
	private buildFallback(showBorder: boolean): string[] {
		const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
		const text = this.theme.fallbackColor(fallback);

		if (showBorder) {
			const style = this.options.borderStyle ?? ROUNDED;
			const colorFn = this.options.borderColorFn ?? ((s: string) => s);
			const innerWidth = fallback.length + 2; // 1 space padding each side
			const top = colorFn(style.topLeft + style.horizontal.repeat(innerWidth) + style.topRight);
			const bottom = colorFn(
				style.bottomLeft + style.horizontal.repeat(innerWidth) + style.bottomRight
			);
			return [top, `${colorFn(style.vertical)} ${text} ${colorFn(style.vertical)}`, bottom];
		}

		return [text];
	}
}
