/**
 * Pure UI helpers for the tasks widget.
 *
 * Contains ANSI color mapping and column-layout utilities used by the widget
 * renderer.  All functions are stateless.
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/**
 * Maps color names to ANSI 256-color codes.
 *
 * @param color - Color name string (green, cyan, magenta, yellow, blue, red)
 * @returns ANSI 256-color code number
 */
export function colorToAnsi(color: string): number {
	const map: Record<string, number> = {
		green: 78,
		cyan: 80,
		magenta: 170,
		yellow: 220,
		blue: 75,
		red: 203,
	};
	return map[color] ?? 78;
}

/**
 * Pad a line to a specific visible width (accounting for ANSI codes).
 *
 * If the line is already wider than `targetWidth`, it is truncated instead.
 *
 * @param line - ANSI-styled line to pad
 * @param targetWidth - Desired visible character width
 * @returns Padded (or truncated) line
 */
export function padToWidth(line: string, targetWidth: number): string {
	const currentWidth = visibleWidth(line);
	if (currentWidth >= targetWidth) {
		return truncateToWidth(line, targetWidth, "");
	}
	return line + " ".repeat(targetWidth - currentWidth);
}

/**
 * Merge two column arrays into side-by-side lines, with right column bottom-aligned.
 *
 * Both columns are truncated to their allotted widths to prevent overflow.
 *
 * @param leftLines - Lines for the left column
 * @param rightLines - Lines for the right column
 * @param leftWidth - Max visible width for left column
 * @param separator - Separator string between columns
 * @param totalWidth - Total terminal width (for right column truncation)
 * @returns Merged lines array
 */
export function mergeSideBySide(
	leftLines: string[],
	rightLines: string[],
	leftWidth: number,
	separator: string,
	totalWidth: number
): string[] {
	const separatorWidth = visibleWidth(separator);
	const rightWidth = totalWidth - leftWidth - separatorWidth;
	const maxRows = Math.max(leftLines.length, rightLines.length);
	const result: string[] = [];

	// Bottom-align: pad right column at the top
	const rightPadding = maxRows - rightLines.length;

	for (let i = 0; i < maxRows; i++) {
		const left = leftLines[i] ?? "";
		const rightIndex = i - rightPadding;
		const rawRight = rightIndex >= 0 ? (rightLines[rightIndex] ?? "") : "";
		// Truncate right column to prevent overflow
		const right =
			rightWidth > 0 && visibleWidth(rawRight) > rightWidth
				? truncateToWidth(rawRight, rightWidth, "")
				: rawRight;
		result.push(padToWidth(left, leftWidth) + separator + right);
	}

	return result;
}
