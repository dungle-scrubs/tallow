import type { TUI } from "../tui.js";
import { Text } from "./text.js";

/** Default braille spinner frames used when no custom frames are provided. */
const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Default animation interval in milliseconds. */
const DEFAULT_INTERVAL_MS = 80;

/** Optional configuration for the Loader's spinner appearance and timing. */
export interface LoaderOptions {
	/** Spinner animation frames (defaults to braille dots). */
	frames?: string[];
	/** Animation interval in ms (default: 80). */
	intervalMs?: number;
}

/** Context passed to the message transform callback each tick. */
export interface MessageTransformContext {
	/** The current message set on this Loader (from constructor or setMessage). */
	message: string;
	/** Monotonic tick counter — increments each animation frame for this instance. */
	tick: number;
	/** True if the message has not been changed via setMessage() since construction. */
	isInitialMessage: boolean;
}

/**
 * Loader component that updates with a spinning animation.
 *
 * @param ui - TUI instance for rendering
 * @param spinnerColorFn - Color function applied to the spinner frame
 * @param messageColorFn - Color function applied to the message text
 * @param message - Text shown next to the spinner (default: "Loading...")
 * @param options - Optional frames and interval override
 */
export class Loader extends Text {
	private frames: string[];
	private intervalMs: number;
	private currentFrame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private _transformIntervalId: NodeJS.Timeout | null = null;
	private ui: TUI | null = null;

	/** Per-instance tick counter for message transform animations. */
	private _transformTick = 0;

	/** Tracks whether setMessage() has been called since construction. */
	private _messageChanged = false;

	constructor(
		ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
		options?: LoaderOptions
	) {
		super("", 1, 0);
		this.frames = options?.frames ?? Loader.defaultFrames ?? DEFAULT_FRAMES;
		this.intervalMs = options?.intervalMs ?? Loader.defaultIntervalMs ?? DEFAULT_INTERVAL_MS;
		this.ui = ui;
		this.start();
	}

	/**
	 * Global default spinner frames — set once, applies to all new Loader instances.
	 * Extensions can set this at session_start to override the braille default.
	 */
	static defaultFrames: string[] | undefined;

	/**
	 * Global default interval — set once, applies to all new Loader instances.
	 */
	static defaultIntervalMs: number | undefined;

	/**
	 * Global message transform — called each tick to modify the displayed message.
	 * Extensions use this to animate or replace the loader text.
	 * Return the string to display. The transform is applied before messageColorFn.
	 */
	static defaultMessageTransform?: (ctx: MessageTransformContext) => string;

	/**
	 * Interval (ms) for the message transform tick — independent of the spinner frame rate.
	 * When set to a value faster than the spinner interval, a separate timer drives
	 * the transform tick and re-renders, giving animations higher
	 * frame rates without affecting the spinner animation speed.
	 */
	static defaultTransformIntervalMs: number | undefined;

	/** Whether the loader is hidden (renders as empty space). */
	private hidden = false;

	/**
	 * Hide the loader — renders nothing but keeps the interval alive.
	 * Call show() to restore.
	 */
	hide() {
		this.hidden = true;
		this.setText("");
		this.ui?.requestRender();
	}

	/**
	 * Show the loader after a hide() call.
	 */
	show() {
		this.hidden = false;
		this.updateDisplay();
	}

	render(width: number): string[] {
		if (this.hidden) return [];
		return ["", ...super.render(width)];
	}

	start() {
		this.updateDisplay();

		const transformMs = Loader.defaultTransformIntervalMs;
		const hasFastTransform =
			Loader.defaultMessageTransform != null &&
			transformMs != null &&
			transformMs < this.intervalMs;

		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this._transformTick++;
			this.updateDisplay();
		}, this.intervalMs);

		// Separate faster interval for message transform re-renders only.
		// Does NOT advance _transformTick — just re-rolls random visuals.
		if (hasFastTransform) {
			this._transformIntervalId = setInterval(() => {
				this.updateDisplay();
			}, transformMs);
		}
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		if (this._transformIntervalId) {
			clearInterval(this._transformIntervalId);
			this._transformIntervalId = null;
		}
	}

	/** Sentinel value — pass to setWorkingMessage() to hide the loader. */
	static readonly HIDE = "\u200B";

	/**
	 * Set the loader message. Pass Loader.HIDE to hide, any other string to show.
	 * @param message - Message text or Loader.HIDE sentinel
	 */
	setMessage(message: string) {
		if (message === Loader.HIDE) {
			this.hide();
			return;
		}
		if (this.hidden) this.show();
		this._messageChanged = true;
		this.message = message;
		this.updateDisplay();
	}

	private updateDisplay() {
		const frame = this.frames[this.currentFrame];
		let displayMessage = this.message;

		if (Loader.defaultMessageTransform) {
			displayMessage = Loader.defaultMessageTransform({
				message: this.message,
				tick: this._transformTick,
				isInitialMessage: !this._messageChanged,
			});
		}

		this.setText(`${this.spinnerColorFn(frame)} ${this.messageColorFn(displayMessage)}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
