/**
 * TUI component snapshot tests.
 *
 * Renders components to plaintext and compares against snapshots.
 * Run `bun test --update-snapshots` to regenerate after intentional changes.
 */
import { describe, expect, it } from "bun:test";
import { renderSnapshot, stripAnsi } from "../../../../test-utils/virtual-terminal.js";
import { Text } from "../components/text.js";
import { Markdown, type MarkdownTheme } from "../components/markdown.js";
import { BorderedBox } from "../components/bordered-box.js";
import { TruncatedText } from "../components/truncated-text.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Identity theme — all styling functions return input unchanged. */
const identityTheme: MarkdownTheme = {
	heading: (t) => t,
	link: (t) => t,
	linkUrl: (t) => t,
	code: (t) => t,
	codeBlock: (t) => t,
	codeBlockBorder: (t) => t,
	quote: (t) => t,
	quoteBorder: (t) => t,
	hr: (t) => t,
	listBullet: (t) => t,
	bold: (t) => t,
	italic: (t) => t,
	strikethrough: (t) => t,
	underline: (t) => t,
};

// ════════════════════════════════════════════════════════════════
// Text
// ════════════════════════════════════════════════════════════════

describe("Text", () => {
	it("renders plain text at width 40", () => {
		const text = new Text("Hello, world!", 0, 0);
		expect(renderSnapshot(text, 40)).toMatchSnapshot();
	});

	it("wraps long text at narrow width", () => {
		const text = new Text("This is a longer piece of text that should wrap at narrow widths", 0, 0);
		expect(renderSnapshot(text, 20)).toMatchSnapshot();
	});

	it("renders with padding", () => {
		const text = new Text("Padded text", 2, 1);
		expect(renderSnapshot(text, 40)).toMatchSnapshot();
	});

	it("handles empty text", () => {
		const text = new Text("", 0, 0);
		expect(renderSnapshot(text, 40)).toMatchSnapshot();
	});

	it("handles multiline text", () => {
		const text = new Text("Line one\nLine two\nLine three", 0, 0);
		expect(renderSnapshot(text, 40)).toMatchSnapshot();
	});
});

// ════════════════════════════════════════════════════════════════
// Markdown
// ════════════════════════════════════════════════════════════════

/** Create a Markdown component with identity theme and no padding. */
function md(text: string): Markdown {
	return new Markdown(text, 0, 0, identityTheme);
}

describe("Markdown", () => {
	it("renders heading", () => {
		expect(renderSnapshot(md("# Hello World"), 40)).toMatchSnapshot();
	});

	it("renders paragraph text", () => {
		expect(
			renderSnapshot(md("Some paragraph text that should be rendered normally."), 40)
		).toMatchSnapshot();
	});

	it("renders code block", () => {
		expect(renderSnapshot(md("```ts\nconst x = 1;\nconst y = 2;\n```"), 40)).toMatchSnapshot();
	});

	it("renders unordered list", () => {
		expect(renderSnapshot(md("- Item one\n- Item two\n- Item three"), 40)).toMatchSnapshot();
	});

	it("renders ordered list", () => {
		expect(renderSnapshot(md("1. First\n2. Second\n3. Third"), 40)).toMatchSnapshot();
	});

	it("renders blockquote", () => {
		expect(renderSnapshot(md("> This is a quote"), 40)).toMatchSnapshot();
	});

	it("renders at narrow width (20)", () => {
		expect(
			renderSnapshot(
				md("# Hello World\n\nSome paragraph text that should wrap at this narrow width."),
				20
			)
		).toMatchSnapshot();
	});

	it("renders inline formatting", () => {
		expect(renderSnapshot(md("Text with **bold** and *italic* and `code`."), 60)).toMatchSnapshot();
	});

	it("renders horizontal rule", () => {
		expect(renderSnapshot(md("Above\n\n---\n\nBelow"), 40)).toMatchSnapshot();
	});

	it("handles empty content", () => {
		expect(renderSnapshot(md(""), 40)).toMatchSnapshot();
	});
});

// ════════════════════════════════════════════════════════════════
// BorderedBox
// ════════════════════════════════════════════════════════════════

describe("BorderedBox", () => {
	it("renders content with default border", () => {
		const box = new BorderedBox(["Hello", "World"]);
		expect(renderSnapshot(box, 30)).toMatchSnapshot();
	});

	it("renders with title", () => {
		const box = new BorderedBox(["Content line"], { title: "My Box" });
		expect(renderSnapshot(box, 30)).toMatchSnapshot();
	});

	it("renders with custom padding", () => {
		const box = new BorderedBox(["Padded"], { paddingX: 3 });
		expect(renderSnapshot(box, 30)).toMatchSnapshot();
	});

	it("handles empty content", () => {
		const box = new BorderedBox([]);
		expect(renderSnapshot(box, 30)).toMatchSnapshot();
	});

	it("handles very narrow width", () => {
		const box = new BorderedBox(["Some content"]);
		// At width 5, inner width = 5 - 2 - 2 = 1
		expect(renderSnapshot(box, 5)).toMatchSnapshot();
	});
});

// ════════════════════════════════════════════════════════════════
// TruncatedText
// ════════════════════════════════════════════════════════════════

describe("TruncatedText", () => {
	it("renders short text without truncation", () => {
		const tt = new TruncatedText("Short");
		expect(renderSnapshot(tt, 40)).toMatchSnapshot();
	});

	it("truncates long text", () => {
		const tt = new TruncatedText("This text is much too long to fit in a narrow terminal");
		expect(renderSnapshot(tt, 20)).toMatchSnapshot();
	});

	it("renders with padding", () => {
		const tt = new TruncatedText("Padded", 2, 1);
		expect(renderSnapshot(tt, 30)).toMatchSnapshot();
	});

	it("handles multiline text (takes first line)", () => {
		const tt = new TruncatedText("First line\nSecond line");
		expect(renderSnapshot(tt, 40)).toMatchSnapshot();
	});
});
