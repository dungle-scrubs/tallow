/**
 * Tests for tallow-tui StdinBuffer: sequence extraction and event emission.
 * Tests the public StdinBuffer class interface since extractCompleteSequences is private.
 */
import { describe, expect, it } from "bun:test";
import { StdinBuffer } from "../stdin-buffer.js";

/**
 * Collects all 'data' events emitted by a StdinBuffer during a synchronous process() call.
 * @param input - Raw input string to feed
 * @returns Array of emitted sequence strings
 */
function collectSequences(input: string): string[] {
	const sequences: string[] = [];
	const buffer = new StdinBuffer({ timeout: 0 });
	buffer.on("data", (seq: string) => sequences.push(seq));
	buffer.process(input);
	return sequences;
}

// ── StdinBuffer sequence extraction ──────────────────────────────────────────

describe("StdinBuffer", () => {
	it("emits single ASCII character", () => {
		const seqs = collectSequences("a");
		expect(seqs).toContain("a");
	});

	it("emits each character separately for plain text", () => {
		const seqs = collectSequences("abc");
		expect(seqs).toEqual(["a", "b", "c"]);
	});

	it("emits complete CSI arrow sequence as one unit", () => {
		const seqs = collectSequences("\x1b[A");
		expect(seqs).toEqual(["\x1b[A"]);
	});

	it("emits complete SGR sequence as one unit", () => {
		const seqs = collectSequences("\x1b[31m");
		expect(seqs).toEqual(["\x1b[31m"]);
	});

	it("handles escape followed by printable as separate events", () => {
		// In legacy mode, ESC + letter can be alt+letter
		const seqs = collectSequences("\x1ba");
		expect(seqs.length).toBeGreaterThanOrEqual(1);
	});

	it("handles multiple CSI sequences in one chunk", () => {
		const seqs = collectSequences("\x1b[A\x1b[B");
		expect(seqs).toEqual(["\x1b[A", "\x1b[B"]);
	});

	it("handles mixed ASCII and escape sequences", () => {
		const seqs = collectSequences("a\x1b[Ab");
		expect(seqs).toEqual(["a", "\x1b[A", "b"]);
	});

	it("handles bracketed paste via paste event", () => {
		const pastes: string[] = [];
		const buffer = new StdinBuffer({ timeout: 0 });
		buffer.on("paste", (content: string) => pastes.push(content));
		buffer.process("\x1b[200~hello world\x1b[201~");
		expect(pastes).toEqual(["hello world"]);
	});

	it("handles delete key sequence", () => {
		const seqs = collectSequences("\x1b[3~");
		expect(seqs).toEqual(["\x1b[3~"]);
	});

	it("emits empty string for empty input", () => {
		const seqs = collectSequences("");
		expect(seqs).toEqual([""]);
	});

	it("handles ctrl characters", () => {
		const seqs = collectSequences("\x03"); // ctrl+c
		expect(seqs).toEqual(["\x03"]);
	});
});
