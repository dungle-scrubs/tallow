import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { fileLink, hyperlink } from "../terminal-links.js";

describe("terminal-links", () => {
	test("hyperlink wraps visible text in OSC 8 markup", () => {
		const result = hyperlink("https://example.com", "click");
		expect(result).toContain("https://example.com");
		expect(result).toContain("click");
		expect(visibleWidth(result)).toBe(5);
	});

	test("fileLink uses file:// URL encoding", () => {
		const result = fileLink("/tmp/path with spaces/file.ts", "file.ts");
		expect(result).toContain("file:///tmp/path%20with%20spaces/file.ts");
		expect(visibleWidth(result)).toBe(7);
	});
});
