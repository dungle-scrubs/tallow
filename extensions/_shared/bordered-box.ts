/**
 * Lightweight bordered-box renderer for bundled extensions.
 *
 * This avoids depending on fork-only `@mariozechner/pi-tui` exports in the
 * published package while preserving the same visual style where needed.
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

interface BorderStyle {
	readonly bottomLeft: string;
	readonly bottomRight: string;
	readonly horizontal: string;
	readonly topLeft: string;
	readonly topRight: string;
	readonly vertical: string;
}

export interface RenderBorderedBoxOptions {
	readonly borderColorFn?: (str: string) => string;
	readonly paddingX?: number;
	readonly style?: "rounded" | "sharp";
	readonly title?: string;
	readonly titleColorFn?: (str: string) => string;
}

const BORDER_STYLES = {
	rounded: {
		bottomLeft: "╰",
		bottomRight: "╯",
		horizontal: "─",
		topLeft: "╭",
		topRight: "╮",
		vertical: "│",
	},
	sharp: {
		bottomLeft: "└",
		bottomRight: "┘",
		horizontal: "─",
		topLeft: "┌",
		topRight: "┐",
		vertical: "│",
	},
} as const satisfies Record<NonNullable<RenderBorderedBoxOptions["style"]>, BorderStyle>;

/**
 * Render content lines inside a bordered box.
 *
 * @param contentLines - Pre-rendered content to wrap
 * @param width - Available render width
 * @param options - Title, padding, border style, and color callbacks
 * @returns Rendered border and body lines
 */
export function renderBorderedBox(
	contentLines: readonly string[],
	width: number,
	options: RenderBorderedBoxOptions = {}
): string[] {
	const style = BORDER_STYLES[options.style ?? "sharp"];
	const padX = options.paddingX ?? 1;
	const colorBorder = options.borderColorFn ?? ((str: string) => str);
	const colorTitle = options.titleColorFn ?? ((str: string) => str);
	const innerWidth = width - 2 - padX * 2;
	if (innerWidth < 1) return [...contentLines];

	const pad = " ".repeat(padX);
	let topBar: string;
	if (options.title) {
		const title = ` ${colorTitle(options.title)} `;
		const rightFill = Math.max(0, width - 3 - visibleWidth(title));
		topBar =
			colorBorder(style.topLeft) +
			colorBorder(style.horizontal) +
			title +
			colorBorder(style.horizontal.repeat(rightFill)) +
			colorBorder(style.topRight);
	} else {
		topBar =
			colorBorder(style.topLeft) +
			colorBorder(style.horizontal.repeat(width - 2)) +
			colorBorder(style.topRight);
	}

	const bodyLines = contentLines.map((line) => {
		const clamped = visibleWidth(line) > innerWidth ? truncateToWidth(line, innerWidth) : line;
		const fill = Math.max(0, innerWidth - visibleWidth(clamped));
		return (
			colorBorder(style.vertical) +
			pad +
			clamped +
			" ".repeat(fill) +
			pad +
			colorBorder(style.vertical)
		);
	});

	const bottomBar =
		colorBorder(style.bottomLeft) +
		colorBorder(style.horizontal.repeat(width - 2)) +
		colorBorder(style.bottomRight);
	return [topBar, ...bodyLines, bottomBar];
}
