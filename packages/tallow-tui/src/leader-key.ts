/**
 * Leader key layer for modal key sequences.
 *
 * Provides a Vim/Emacs-style leader key that activates a secondary keymap.
 * When the leader key is pressed, subsequent keystrokes are intercepted
 * and matched against registered bindings. The layer auto-deactivates
 * after a configurable timeout.
 *
 * Supports both single-key bindings (via KeyId) and multi-character
 * sequences (Vimium-style hint matching with prefix narrowing).
 *
 * Uses TUI input middleware to synchronously intercept all keystrokes
 * before the focused component receives them.
 */

import type { KeyId } from "./keys.js";
import { matchesKey } from "./keys.js";
import type { Component, TUI } from "./tui.js";

/**
 * Configuration for the leader key layer.
 */
export interface LeaderKeyOptions {
	/** Key that activates leader mode. Default: "ctrl+x" */
	leaderKey?: KeyId;
	/** Timeout in ms before auto-deactivation. Default: 5000 */
	timeout?: number;
	/** Border color function applied to the editor while active */
	activeBorderColor?: (s: string) => string;
	/** Called when leader mode activates */
	onActivate?: () => void;
	/** Called when leader mode deactivates */
	onDeactivate?: () => void;
	/**
	 * Called when the sequence buffer changes (user typed a character).
	 * Use to update visual hints (dim non-matching labels).
	 *
	 * @param buffer - Characters typed so far
	 */
	onBufferChange?: (buffer: string) => void;
}

/** Default bright magenta border for maximum contrast against any theme */
const DEFAULT_ACTIVE_BORDER_COLOR = (s: string): string => `\x1b[38;5;201m${s}\x1b[39m`;

/**
 * Generate Vimium-style hint labels for N items.
 *
 * Uses the minimum depth needed: single chars for ≤26 items,
 * two chars for ≤676, etc. Labels are distributed so that each
 * prefix fans out evenly across the alphabet.
 *
 * @param count - Number of labels to generate
 * @returns Array of lowercase label strings
 */
export function generateHintLabels(count: number): string[] {
	if (count <= 0) return [];
	const chars = "abcdefghijklmnopqrstuvwxyz";
	const base = chars.length;

	// Determine minimum depth
	let depth = 1;
	let capacity = base;
	while (capacity < count) {
		depth++;
		capacity *= base;
	}

	const labels: string[] = [];
	for (let i = 0; i < count; i++) {
		let label = "";
		let n = i;
		for (let d = depth - 1; d >= 0; d--) {
			const divisor = base ** d;
			const idx = Math.floor(n / divisor);
			label += chars[idx];
			n %= divisor;
		}
		labels.push(label);
	}
	return labels;
}

/**
 * A modal input layer that intercepts keystrokes after a leader key press.
 *
 * Supports two binding types:
 * - **Single-key bindings** via `registerBinding(key, handler)` — matched with `matchesKey`
 * - **Sequence bindings** via `registerSequence(seq, handler)` — buffered character matching
 *   with prefix narrowing (Vimium-style)
 *
 * Activation flow:
 * 1. User presses the leader key (default: Ctrl+X)
 * 2. Editor border changes to the active color
 * 3. All subsequent input is consumed by the layer
 * 4. Typed characters buffer and narrow against registered sequences
 * 5. When a sequence uniquely matches, the handler fires and leader mode exits
 * 6. Escape or re-pressing the leader key deactivates
 * 7. Timeout auto-deactivates after the configured duration
 *
 * @example
 * ```ts
 * const layer = new LeaderKeyLayer({ timeout: 3000 });
 * layer.attach(tui, editor);
 * layer.registerSequence("aa", () => expandTool(0));
 * layer.registerSequence("ab", () => expandTool(1));
 * ```
 */
export class LeaderKeyLayer {
	private readonly leaderKey: KeyId;
	private readonly timeout: number;
	private readonly activeBorderColor: (s: string) => string;
	private readonly onActivateCb?: () => void;
	private readonly onDeactivateCb?: () => void;
	private readonly onBufferChangeCb?: (buffer: string) => void;

	private active = false;
	private buffer = "";
	private timer: ReturnType<typeof setTimeout> | null = null;
	private bindings = new Map<KeyId, () => void>();
	private sequences = new Map<string, () => void>();

	private tui: TUI | null = null;
	private editor: (Component & { borderColor?: (s: string) => string }) | null = null;
	private originalBorderColor: ((s: string) => string) | undefined;
	private middlewareFn: ((data: string) => boolean) | null = null;

	constructor(options: LeaderKeyOptions = {}) {
		this.leaderKey = options.leaderKey ?? "ctrl+x";
		this.timeout = options.timeout ?? 5000;
		this.activeBorderColor = options.activeBorderColor ?? DEFAULT_ACTIVE_BORDER_COLOR;
		this.onActivateCb = options.onActivate;
		this.onDeactivateCb = options.onDeactivate;
		this.onBufferChangeCb = options.onBufferChange;
	}

	/**
	 * Attach the layer to a TUI instance and editor component.
	 * Registers input middleware that intercepts keystrokes when active.
	 *
	 * @param tui - The TUI instance for middleware and render requests
	 * @param editor - The editor component whose borderColor will be swapped
	 */
	attach(tui: TUI, editor: Component & { borderColor?: (s: string) => string }): void {
		this.detach();
		this.tui = tui;
		this.editor = editor;

		this.middlewareFn = (data: string): boolean => this.middleware(data);
		tui.addInputMiddleware(this.middlewareFn);
	}

	/**
	 * Detach the layer, removing middleware and restoring state.
	 * Safe to call multiple times or when not attached.
	 */
	detach(): void {
		if (this.active) {
			this.deactivate();
		}
		if (this.tui && this.middlewareFn) {
			this.tui.removeInputMiddleware(this.middlewareFn);
		}
		this.tui = null;
		this.editor = null;
		this.middlewareFn = null;
	}

	/**
	 * Register a single-key binding that fires when pressed during leader mode.
	 *
	 * @param key - The key to bind (e.g., "t", "?", "p")
	 * @param handler - Callback executed when the key is pressed
	 */
	registerBinding(key: KeyId, handler: () => void): void {
		this.bindings.set(key, handler);
	}

	/**
	 * Remove a previously registered single-key binding.
	 *
	 * @param key - The key to unbind
	 */
	unregisterBinding(key: KeyId): void {
		this.bindings.delete(key);
	}

	/**
	 * Register a multi-character sequence binding (Vimium-style).
	 * Characters are buffered as the user types; when the buffer
	 * matches a sequence exactly, the handler fires.
	 *
	 * @param seq - Character sequence (e.g., "aa", "ab", "b")
	 * @param handler - Callback executed on match
	 */
	registerSequence(seq: string, handler: () => void): void {
		this.sequences.set(seq.toLowerCase(), handler);
	}

	/**
	 * Remove a previously registered sequence binding.
	 *
	 * @param seq - The sequence to unbind
	 */
	unregisterSequence(seq: string): void {
		this.sequences.delete(seq.toLowerCase());
	}

	/**
	 * Remove all registered sequence bindings.
	 */
	clearSequences(): void {
		this.sequences.clear();
	}

	/**
	 * Check whether leader mode is currently active.
	 *
	 * @returns true if the layer is intercepting input
	 */
	isActive(): boolean {
		return this.active;
	}

	/**
	 * Get the current sequence buffer contents.
	 *
	 * @returns Characters typed so far during this activation
	 */
	getBuffer(): string {
		return this.buffer;
	}

	/**
	 * Input middleware — runs before the focused component receives input.
	 * Returns true to consume the keystroke, false to pass through.
	 *
	 * @param data - Raw terminal input data
	 * @returns true if consumed
	 */
	private middleware(data: string): boolean {
		if (!this.active) {
			if (matchesKey(data, this.leaderKey)) {
				this.activate();
				return true;
			}
			return false;
		}

		// Active — intercept everything

		// Leader key again → toggle off
		if (matchesKey(data, this.leaderKey)) {
			this.deactivate();
			return true;
		}

		// Escape → deactivate
		if (matchesKey(data, "escape")) {
			this.deactivate();
			return true;
		}

		// Check single-key bindings (take precedence over sequences)
		for (const [key, handler] of this.bindings) {
			if (matchesKey(data, key)) {
				this.deactivate();
				handler();
				return true;
			}
		}

		// Sequence handling: buffer printable ASCII characters
		const code = data.charCodeAt(0);
		if (data.length === 1 && code >= 32 && code < 127) {
			this.buffer += data.toLowerCase();

			// Exact match → execute
			const handler = this.sequences.get(this.buffer);
			if (handler) {
				this.deactivate();
				handler();
				return true;
			}

			// Prefix match → wait for more input
			const hasPrefix = this.hasSequencePrefix(this.buffer);
			if (hasPrefix) {
				this.onBufferChangeCb?.(this.buffer);
				this.resetTimer();
				return true;
			}

			// No match possible → deactivate
			this.deactivate();
			return true;
		}

		// Non-printable input while active → consume and reset
		this.resetTimer();
		return true;
	}

	/**
	 * Check if any registered sequence starts with the given prefix.
	 *
	 * @param prefix - The prefix to check
	 * @returns true if at least one sequence starts with prefix
	 */
	private hasSequencePrefix(prefix: string): boolean {
		for (const seq of this.sequences.keys()) {
			if (seq.startsWith(prefix)) return true;
		}
		return false;
	}

	/**
	 * Activate leader mode: swap border color, start timeout, clear buffer.
	 */
	private activate(): void {
		this.active = true;
		this.buffer = "";

		if (this.editor) {
			this.originalBorderColor = this.editor.borderColor;
			this.editor.borderColor = this.activeBorderColor;
		}

		this.resetTimer();
		this.onActivateCb?.();
		this.tui?.requestRender();
	}

	/**
	 * Deactivate leader mode: restore border color, clear timeout and buffer.
	 */
	deactivate(): void {
		this.active = false;
		this.buffer = "";
		this.clearTimer();

		if (this.editor) {
			this.editor.borderColor = this.originalBorderColor;
		}

		this.onDeactivateCb?.();
		this.tui?.requestRender();
	}

	/**
	 * Reset the auto-deactivation timer to the full duration.
	 */
	private resetTimer(): void {
		this.clearTimer();
		this.timer = setTimeout(() => this.deactivate(), this.timeout);
	}

	/**
	 * Clear any pending timeout.
	 */
	private clearTimer(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
}
