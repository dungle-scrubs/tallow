/**
 * Tests for prompt suggestion templates.
 */
import { describe, expect, test } from "bun:test";
import { CONTEXTUAL_TEMPLATES, GENERAL_TEMPLATES } from "../templates.js";

describe("GENERAL_TEMPLATES", () => {
	test("has at least 10 templates", () => {
		expect(GENERAL_TEMPLATES.length).toBeGreaterThanOrEqual(10);
	});

	test("all templates have non-empty text", () => {
		for (const t of GENERAL_TEMPLATES) {
			expect(t.text.length).toBeGreaterThan(0);
		}
	});

	test("all templates have tags", () => {
		for (const t of GENERAL_TEMPLATES) {
			expect(t.tags).toBeDefined();
			expect(t.tags?.length).toBeGreaterThan(0);
		}
	});

	test("no duplicate texts", () => {
		const texts = GENERAL_TEMPLATES.map((t) => t.text);
		expect(new Set(texts).size).toBe(texts.length);
	});
});

describe("CONTEXTUAL_TEMPLATES", () => {
	test("has templates for continued sessions", () => {
		const continued = CONTEXTUAL_TEMPLATES.filter((t) => t.tags?.includes("continued"));
		expect(continued.length).toBeGreaterThanOrEqual(1);
	});

	test("has templates for error context", () => {
		const errors = CONTEXTUAL_TEMPLATES.filter((t) => t.tags?.includes("error"));
		expect(errors.length).toBeGreaterThanOrEqual(1);
	});
});
