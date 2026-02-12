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
	private ui: TUI | null = null;

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

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start() {
		this.updateDisplay();
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, this.intervalMs);
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setMessage(message: string) {
		this.message = message;
		this.updateDisplay();
	}

	private updateDisplay() {
		const frame = this.frames[this.currentFrame];
		this.setText(`${this.spinnerColorFn(frame)} ${this.messageColorFn(this.message)}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
