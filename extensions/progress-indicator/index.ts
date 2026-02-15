/**
 * Progress Indicator Extension
 *
 * Emits OSC 9;4 terminal sequences to show progress in the terminal's
 * title bar or tab indicator during agent turns. Uses indeterminate mode
 * (pulsing/spinning) since total tool calls aren't known ahead of time.
 *
 * Supported terminals: Windows Terminal, iTerm2, WezTerm, and others
 * that implement the ConEmu-style OSC 9;4 progress protocol.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** OSC 9;4 state=3 (indeterminate/pulsing progress) */
const OSC_INDETERMINATE = "\x1b]9;4;3;0\x07";
/** OSC 9;4 state=0 (clear/remove progress) */
const OSC_CLEAR = "\x1b]9;4;0;0\x07";

/**
 * Write an OSC 9;4 progress sequence to stdout if connected to a TTY.
 * @param sequence - The raw OSC escape sequence to emit
 */
function writeOsc(sequence: string): void {
	if (process.stdout.isTTY) {
		process.stdout.write(sequence);
	}
}

/**
 * Progress indicator extension.
 * Emits OSC 9;4 sequences during agent turns to show indeterminate
 * progress in the terminal tab/title bar, clearing when the turn ends.
 *
 * @param pi - Extension API
 */
export default function progressIndicatorExtension(pi: ExtensionAPI): void {
	pi.on("turn_start", () => {
		writeOsc(OSC_INDETERMINATE);
	});

	pi.on("turn_end", () => {
		writeOsc(OSC_CLEAR);
	});

	pi.on("agent_end", () => {
		writeOsc(OSC_CLEAR);
	});

	pi.on("session_shutdown", () => {
		writeOsc(OSC_CLEAR);
	});
}
