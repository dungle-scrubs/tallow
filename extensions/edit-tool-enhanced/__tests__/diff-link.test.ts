import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import { buildDiffLink, isInGitRepo, isOnPath } from "../index.js";

// ── isOnPath ────────────────────────────────────────────────

describe("isOnPath", () => {
	test("returns true for a common executable (node)", () => {
		expect(isOnPath("node")).toBe(true);
	});

	test("returns false for a nonexistent executable", () => {
		expect(isOnPath("__definitely_not_a_binary_xyzzy__")).toBe(false);
	});
});

// ── isInGitRepo ─────────────────────────────────────────────

describe("isInGitRepo", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-diff-test-"));
		fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello\n");
	});

	afterAll(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns true for a file inside this git repo", () => {
		// This test file itself is in the tallow repo
		expect(isInGitRepo(__filename)).toBe(true);
	});

	test("returns false for a file outside any git repo", () => {
		expect(isInGitRepo(path.join(tmpDir, "file.txt"))).toBe(false);
	});
});

// ── buildDiffLink ───────────────────────────────────────────

describe("buildDiffLink", () => {
	/** Identity themeFg — returns text unchanged for easy assertion. */
	const identityFg = (_style: ThemeColor, text: string) => text;

	test("returns empty string when lazygit not available", () => {
		const result = buildDiffLink("src/index.ts", identityFg, false);
		expect(result).toBe("");
	});

	test("returns empty string for file outside git repo", () => {
		const tmpFile = path.join(os.tmpdir(), "__no_git__", "file.txt");
		const result = buildDiffLink(tmpFile, identityFg, true);
		expect(result).toBe("");
	});

	test("returns OSC 8 link with tallow://diff/ scheme for tracked file", () => {
		// Use a file that exists in this repo
		const result = buildDiffLink("extensions/edit-tool-enhanced/index.ts", identityFg, true);

		// Should contain the OSC 8 escape sequences
		expect(result).toContain("\x1b]8;;");
		expect(result).toContain("tallow://diff/");
		expect(result).toContain("diff"); // visible text
		expect(result).toContain("\x1b]8;;\x07"); // OSC 8 terminator
	});

	test("URL-encodes the absolute file path", () => {
		const result = buildDiffLink("extensions/edit-tool-enhanced/index.ts", identityFg, true);
		const absPath = path.resolve(process.cwd(), "extensions/edit-tool-enhanced/index.ts");

		expect(result).toContain(encodeURIComponent(absPath));
	});

	test("applies theme fg to the link text", () => {
		const mockFg = (style: ThemeColor, text: string) => `[${style}:${text}]`;
		const result = buildDiffLink("extensions/edit-tool-enhanced/index.ts", mockFg, true);

		// Should wrap the hyperlink in the dim style
		expect(result).toContain("[dim:");
	});
});
