/**
 * Render Stabilizer Extension
 *
 * Prevents the visual flicker that occurs when resuming a session.
 * During session switches, the chat container is cleared and rebuilt,
 * which causes rapid content height changes. The TUI's shrink-detection
 * redraws use screen clears (`\x1b[2J`) that produce visible blank frames.
 *
 * This extension resets the TUI's render grace period at the start of
 * each session switch so the gentler line-by-line redraw is used instead
 * of the screen-clearing approach.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";

/** Reference to the TUI instance, captured on first session_start. */
let tuiRef: TUI | null = null;

/**
 * Capture the TUI reference by briefly setting a widget with a factory function.
 * The factory receives the TUI instance as its first argument.
 *
 * @param ui - Extension UI context
 */
function captureTuiRef(ui: {
	setWidget: (
		key: string,
		content:
			| undefined
			| ((tui: TUI, theme: unknown) => { render: (w: number) => string[]; invalidate: () => void })
	) => void;
}): void {
	if (tuiRef) return;
	ui.setWidget("_render-stabilizer", (tui: TUI) => {
		tuiRef = tui;
		return { render: () => [], invalidate: () => {} };
	});
	// Remove the widget immediately — it was only needed to capture the ref
	ui.setWidget("_render-stabilizer", undefined);
}

/**
 * Register render stabilization hooks.
 *
 * @param pi - Extension API
 */
export default function renderStabilizerExtension(pi: ExtensionAPI): void {
	// Capture the TUI reference on first session_start
	pi.on("session_start", async (_event, ctx) => {
		captureTuiRef(ctx.ui);
	});

	// Reset the render grace period before a session switch so the
	// chatContainer.clear() → renderInitialMessages() transition uses
	// gentle line-by-line redraws instead of screen-clearing redraws.
	pi.on("session_before_switch", async (_event, ctx) => {
		captureTuiRef(ctx.ui);
		if (
			tuiRef &&
			typeof (tuiRef as TUI & { resetRenderGrace?: () => void }).resetRenderGrace === "function"
		) {
			(tuiRef as TUI & { resetRenderGrace: () => void }).resetRenderGrace();
		}
	});
}
