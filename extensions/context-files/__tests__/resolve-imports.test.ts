import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveImports } from "../index.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = join(tmpdir(), `ctx-imports-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveImports", () => {
	test("returns content unchanged when no directives present", () => {
		const content = "# Hello\n\nSome text.\n";
		expect(resolveImports(content, tmpDir)).toBe(content);
	});

	test("inlines a relative file import", () => {
		writeFileSync(join(tmpDir, "included.md"), "Included content");
		const content = "Before\n@./included.md\nAfter";
		const result = resolveImports(content, tmpDir);
		expect(result).toBe("Before\nIncluded content\nAfter");
	});

	test("inlines a bare filename import", () => {
		writeFileSync(join(tmpDir, "rules.md"), "Rule 1");
		const content = "Header\n@rules.md\nFooter";
		const result = resolveImports(content, tmpDir);
		expect(result).toBe("Header\nRule 1\nFooter");
	});

	test("resolves nested imports recursively", () => {
		writeFileSync(join(tmpDir, "a.md"), "A start\n@./b.md\nA end");
		writeFileSync(join(tmpDir, "b.md"), "B content");
		const content = "@./a.md";
		const result = resolveImports(content, tmpDir);
		expect(result).toBe("A start\nB content\nA end");
	});

	test("detects circular imports", () => {
		writeFileSync(join(tmpDir, "a.md"), "A\n@./b.md");
		writeFileSync(join(tmpDir, "b.md"), "B\n@./a.md");
		const content = "@./a.md";
		const result = resolveImports(content, tmpDir);
		expect(result).toContain("A");
		expect(result).toContain("B");
		expect(result).toContain("Circular import skipped");
	});

	test("skips binary file extensions", () => {
		writeFileSync(join(tmpDir, "image.png"), "fake png");
		const content = "@./image.png";
		const result = resolveImports(content, tmpDir);
		expect(result).toContain("Binary file skipped");
	});

	test("shows comment for missing files", () => {
		const content = "@./nonexistent.md";
		const result = resolveImports(content, tmpDir);
		expect(result).toContain("Import not found");
	});

	test("does not treat @ in normal text as import", () => {
		const content = "Email: user@example.com\n@not-a-file";
		const result = resolveImports(content, tmpDir);
		// Neither line matches the directive pattern
		expect(result).toBe(content);
	});

	test("resolves parent-relative paths", () => {
		const subDir = join(tmpDir, "sub");
		mkdirSync(subDir);
		writeFileSync(join(tmpDir, "root.md"), "Root file");
		const content = "@../root.md";
		const result = resolveImports(content, subDir);
		expect(result).toBe("Root file");
	});

	test("respects max import depth", () => {
		// Create a chain deeper than MAX_IMPORT_DEPTH (10)
		for (let i = 0; i < 12; i++) {
			const next = i < 11 ? `@./file${i + 1}.md` : "leaf";
			writeFileSync(join(tmpDir, `file${i}.md`), next);
		}
		const content = "@./file0.md";
		const result = resolveImports(content, tmpDir);
		// Should stop recursing at some point, not crash
		expect(result).toBeDefined();
	});
});
