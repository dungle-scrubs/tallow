import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandFileReferences } from "../index.js";

/** Temporary directory for test fixtures. */
let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-ref-test-"));

	// Create test fixtures
	fs.writeFileSync(path.join(tmpDir, "hello.ts"), 'const x = "hello";\n');
	fs.writeFileSync(path.join(tmpDir, "README.md"), "# Title\n\nSome docs.\n");
	fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=abc\n");
	fs.writeFileSync(path.join(tmpDir, "noext"), "plain content\n");
	fs.mkdirSync(path.join(tmpDir, "src"));
	fs.writeFileSync(path.join(tmpDir, "src", "main.py"), "print('hello')\n");
	fs.mkdirSync(path.join(tmpDir, "subdir"));

	// Large file (over 100KB)
	const bigContent = `${"x".repeat(150 * 1024)}\n`;
	fs.writeFileSync(path.join(tmpDir, "big.txt"), bigContent);

	// Binary file (contains null bytes)
	const binaryBuf = Buffer.alloc(64);
	binaryBuf.write("PNG");
	// Null bytes are already there from Buffer.alloc
	fs.writeFileSync(path.join(tmpDir, "image.png"), binaryBuf);
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Pattern Matching ────────────────────────────────────────

describe("pattern matching", () => {
	test("matches @path/to/file.ts", () => {
		const result = expandFileReferences("Review @src/main.py", tmpDir);
		expect(result).toContain("print('hello')");
		expect(result).toContain("```python");
	});

	test("matches @README.md (top-level)", () => {
		const result = expandFileReferences("Check @README.md", tmpDir);
		expect(result).toContain("# Title");
		expect(result).toContain("```md");
	});

	test("matches @.env (dotfiles)", () => {
		const result = expandFileReferences("See @.env", tmpDir);
		expect(result).toContain("SECRET=abc");
	});

	test("does not match email addresses", () => {
		const input = "Contact user@example.com for help";
		expect(expandFileReferences(input, tmpDir)).toBe(input);
	});

	test("does not match when preceded by word char", () => {
		const input = "use foo@bar.ts as decorator";
		expect(expandFileReferences(input, tmpDir)).toBe(input);
	});

	test("matches multiple refs in one input", () => {
		const result = expandFileReferences("Compare @hello.ts and @README.md", tmpDir);
		expect(result).toContain('const x = "hello"');
		expect(result).toContain("# Title");
	});

	test("matches @path at start of line", () => {
		const result = expandFileReferences("@hello.ts is the file", tmpDir);
		expect(result).toContain('const x = "hello"');
	});

	test("matches @path after whitespace", () => {
		const result = expandFileReferences("file: @hello.ts", tmpDir);
		expect(result).toContain('const x = "hello"');
	});
});

// ── Fenced Code Block Exclusion ─────────────────────────────

describe("fenced code block exclusion", () => {
	test("skips @ref inside triple-backtick block", () => {
		const input = "text\n```\n@hello.ts\n```\nmore";
		const result = expandFileReferences(input, tmpDir);
		// @hello.ts inside fence should NOT be expanded
		expect(result).not.toContain('const x = "hello"');
		expect(result).toContain("@hello.ts");
	});

	test("skips @ref inside tilde fence block", () => {
		const input = "text\n~~~\n@hello.ts\n~~~\nmore";
		const result = expandFileReferences(input, tmpDir);
		expect(result).not.toContain('const x = "hello"');
	});

	test("expands @ref outside code blocks", () => {
		const input = "```\ncode\n```\n@hello.ts";
		const result = expandFileReferences(input, tmpDir);
		expect(result).toContain('const x = "hello"');
	});

	test("handles unclosed fence (extends to end)", () => {
		const input = "```\n@hello.ts\nno closing fence";
		const result = expandFileReferences(input, tmpDir);
		expect(result).not.toContain('const x = "hello"');
	});
});

// ── File Reading ────────────────────────────────────────────

describe("file reading", () => {
	test("reads file and formats with code block", () => {
		const result = expandFileReferences("@hello.ts", tmpDir);
		expect(result).toContain("`hello.ts`:");
		expect(result).toContain("```ts");
		expect(result).toContain('const x = "hello";');
		expect(result).toContain("```");
	});

	test("truncates files larger than 100KB", () => {
		const result = expandFileReferences("@big.txt", tmpDir);
		expect(result).toContain("[truncated:");
		expect(result).toContain("showing first 100KB");
	});

	test("detects binary files and returns marker", () => {
		const result = expandFileReferences("@image.png", tmpDir);
		expect(result).toBe("[binary file: image.png]");
	});

	test("leaves non-existent files unchanged", () => {
		const input = "see @nonexistent-file.ts";
		expect(expandFileReferences(input, tmpDir)).toBe(input);
	});

	test("leaves directories unchanged", () => {
		const input = "see @subdir";
		expect(expandFileReferences(input, tmpDir)).toBe(input);
	});
});

// ── Language Hints ──────────────────────────────────────────

describe("language hints", () => {
	test("maps .ts to ts", () => {
		const result = expandFileReferences("@hello.ts", tmpDir);
		expect(result).toContain("```ts");
	});

	test("maps .py to python", () => {
		const result = expandFileReferences("@src/main.py", tmpDir);
		expect(result).toContain("```python");
	});

	test("maps .md to md", () => {
		const result = expandFileReferences("@README.md", tmpDir);
		expect(result).toContain("```md");
	});

	test("returns empty hint for extensionless files", () => {
		const result = expandFileReferences("@noext", tmpDir);
		expect(result).toContain("```\n");
	});
});

// ── Integration ─────────────────────────────────────────────

describe("expandFileReferences integration", () => {
	test("returns input unchanged when no patterns present", () => {
		const input = "just a normal message";
		expect(expandFileReferences(input, tmpDir)).toBe(input);
	});

	test("does not re-scan expanded output", () => {
		// If file content contained @README.md, it should NOT be re-expanded.
		// Create a file whose content contains an @ref pattern.
		const metaPath = path.join(tmpDir, "meta.txt");
		fs.writeFileSync(metaPath, "see @hello.ts for details\n");

		const result = expandFileReferences("@meta.txt", tmpDir);
		// meta.txt content is inlined, but the @hello.ts inside it
		// should appear as literal text, not further expanded
		expect(result).toContain("see @hello.ts for details");
		// Should NOT contain the *content* of hello.ts
		const helloOccurrences = result.split('const x = "hello"').length - 1;
		expect(helloOccurrences).toBe(0);
	});

	test("preserves surrounding text with multiple refs", () => {
		const result = expandFileReferences("before @hello.ts middle @README.md after", tmpDir);
		expect(result).toStartWith("before ");
		expect(result).toEndWith("after");
		expect(result).toContain("middle");
	});
});
