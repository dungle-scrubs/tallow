/**
 * Wrap visible text in an OSC 8 terminal hyperlink.
 *
 * @param url - Target URL
 * @param text - Visible link text
 * @returns OSC 8 hyperlink sequence
 */
export function hyperlink(url: string, text: string): string {
	return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}

/**
 * Wrap a file path in an OSC 8 hyperlink using the file:// protocol.
 *
 * @param filePath - Absolute or relative file path
 * @param displayText - Optional visible text override
 * @returns File path wrapped in a file:// OSC 8 hyperlink
 */
export function fileLink(filePath: string, displayText?: string): string {
	const url = `file://${encodeURI(filePath)}`;
	return hyperlink(url, displayText ?? filePath);
}
