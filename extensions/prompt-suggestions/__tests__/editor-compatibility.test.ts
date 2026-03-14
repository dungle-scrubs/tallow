/**
 * Tests for prompt-suggestions editor capability detection.
 */

import { describe, expect, test } from "bun:test";
import { resolvePromptSuggestionEditor } from "../index.js";

describe("resolvePromptSuggestionEditor", () => {
	test("returns editor when ghost-text APIs are available", () => {
		const editor = {
			addChangeListener() {},
			getText() {
				return "hello";
			},
			setGhostText() {},
		};

		expect(resolvePromptSuggestionEditor(editor)).toBe(editor);
	});

	test("returns null when setGhostText is missing", () => {
		const editor = {
			addChangeListener() {},
			getText() {
				return "hello";
			},
		};

		expect(resolvePromptSuggestionEditor(editor)).toBeNull();
	});

	test("returns null when addChangeListener is missing", () => {
		const editor = {
			getText() {
				return "hello";
			},
			setGhostText() {},
		};

		expect(resolvePromptSuggestionEditor(editor)).toBeNull();
	});
});
