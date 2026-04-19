/**
 * Random spinner extension.
 *
 * Spinner customization previously depended on fork-only Loader globals.
 * The pi-tui fork is being reduced back toward upstream behavior, so this
 * extension now intentionally leaves Loader behavior unchanged.
 *
 * @param pi - Extension API
 * @returns Nothing
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function randomSpinnerExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {});
}
