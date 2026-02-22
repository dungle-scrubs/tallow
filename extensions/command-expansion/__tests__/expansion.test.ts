/**
 * Tests for command-expansion pure functions: argument parsing, placeholder
 * substitution, and outer command splitting.
 */
import { describe, expect, it } from "bun:test";
import { ExtensionHarness } from "../../../test-utils/extension-harness.js";
import {
	parseCommandArgs,
	registerCommandExpansionExtension,
	splitOuterCommand,
	substituteArgs,
} from "../index.js";

// ── parseCommandArgs ─────────────────────────────────────────────────────────

describe("parseCommandArgs", () => {
	it("splits simple space-separated args", () => {
		expect(parseCommandArgs("a b c")).toEqual(["a", "b", "c"]);
	});

	it("handles double-quoted args", () => {
		expect(parseCommandArgs('"hello world" foo')).toEqual(["hello world", "foo"]);
	});

	it("handles single-quoted args", () => {
		expect(parseCommandArgs("'hello world' foo")).toEqual(["hello world", "foo"]);
	});

	it("returns empty array for empty input", () => {
		expect(parseCommandArgs("")).toEqual([]);
	});

	it("handles extra whitespace", () => {
		expect(parseCommandArgs("  a   b  ")).toEqual(["a", "b"]);
	});

	it("handles tab separation", () => {
		expect(parseCommandArgs("a\tb")).toEqual(["a", "b"]);
	});

	it("handles single argument", () => {
		expect(parseCommandArgs("hello")).toEqual(["hello"]);
	});

	it("handles mixed quotes", () => {
		expect(parseCommandArgs("\"first\" 'second' third")).toEqual(["first", "second", "third"]);
	});
});

// ── substituteArgs ───────────────────────────────────────────────────────────

describe("substituteArgs", () => {
	it("replaces $1 placeholder", () => {
		expect(substituteArgs("Hello $1", ["world"])).toBe("Hello world");
	});

	it("replaces $ARGUMENTS with all args joined", () => {
		expect(substituteArgs("Run: $ARGUMENTS", ["a", "b"])).toBe("Run: a b");
	});

	it("replaces $@ with all args joined", () => {
		expect(substituteArgs("All: $@", ["x", "y"])).toBe("All: x y");
	});

	it("replaces missing positional arg with empty string", () => {
		expect(substituteArgs("Hello $2", ["only-one"])).toBe("Hello ");
	});

	// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder syntax
	it("handles ${@:N} slice syntax", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder syntax
		expect(substituteArgs("Rest: ${@:2}", ["a", "b", "c"])).toBe("Rest: b c");
	});

	// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder syntax
	it("handles ${@:N:L} slice with length", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal placeholder syntax
		expect(substituteArgs("Mid: ${@:2:1}", ["a", "b", "c"])).toBe("Mid: b");
	});

	it("leaves text without placeholders unchanged", () => {
		expect(substituteArgs("plain text", ["arg"])).toBe("plain text");
	});

	it("handles multiple positional args", () => {
		expect(substituteArgs("$1 and $2", ["first", "second"])).toBe("first and second");
	});

	it("handles empty args array", () => {
		expect(substituteArgs("Hello $1", [])).toBe("Hello ");
	});

	it("handles no args with $ARGUMENTS", () => {
		expect(substituteArgs("Run: $ARGUMENTS", [])).toBe("Run: ");
	});
});

// ── splitOuterCommand ────────────────────────────────────────────────────────

describe("splitOuterCommand", () => {
	it("extracts command and args", () => {
		expect(splitOuterCommand("/cmd args here")).toEqual({
			outerCommand: "/cmd",
			args: "args here",
		});
	});

	it("handles command with no args", () => {
		expect(splitOuterCommand("/cmd")).toEqual({
			outerCommand: "/cmd",
			args: "",
		});
	});

	it("returns null for non-command text", () => {
		expect(splitOuterCommand("not a command")).toBeNull();
	});

	it("handles nested commands", () => {
		expect(splitOuterCommand("/cmd1 /cmd2 args")).toEqual({
			outerCommand: "/cmd1",
			args: "/cmd2 args",
		});
	});

	it("returns null for empty string", () => {
		expect(splitOuterCommand("")).toBeNull();
	});
});

// ── Extension Lazy Initialization ───────────────────────────────────────────

describe("command-expansion lazy resource initialization", () => {
	it("does not load resources on init/session_start or non-eligible input", async () => {
		let skillLoads = 0;
		let templateLoads = 0;
		const harness = ExtensionHarness.create();

		registerCommandExpansionExtension(harness.api, {
			loadSkills: () => {
				skillLoads += 1;
				return { skills: [] };
			},
			loadPromptTemplates: () => {
				templateLoads += 1;
				return [];
			},
		});

		expect(skillLoads).toBe(0);
		expect(templateLoads).toBe(0);

		await harness.fireEvent("session_start", { type: "session_start" });
		expect(skillLoads).toBe(0);
		expect(templateLoads).toBe(0);

		const [plainResult] = await harness.fireEvent("input", { text: "hello world" });
		expect(plainResult).toEqual({ action: "continue" });
		expect(skillLoads).toBe(0);
		expect(templateLoads).toBe(0);

		const [noNestedResult] = await harness.fireEvent("input", { text: "/outer just words" });
		expect(noNestedResult).toEqual({ action: "continue" });
		expect(skillLoads).toBe(0);
		expect(templateLoads).toBe(0);
	});

	it("loads once on first eligible input and reloads after session_start", async () => {
		let skillLoads = 0;
		let templateLoads = 0;
		const harness = ExtensionHarness.create();

		registerCommandExpansionExtension(harness.api, {
			loadSkills: () => {
				skillLoads += 1;
				return { skills: [] };
			},
			loadPromptTemplates: () => {
				templateLoads += 1;
				return [
					{
						name: "tmpl",
						content: "expanded-$1",
						filePath: "/tmp/tmpl.md",
					},
				];
			},
		});

		const [firstResult] = await harness.fireEvent("input", { text: "/outer /tmpl one" });
		expect(firstResult).toEqual({ action: "transform", text: "/outer expanded-one" });
		expect(skillLoads).toBe(1);
		expect(templateLoads).toBe(1);

		const [secondResult] = await harness.fireEvent("input", { text: "/outer /tmpl two" });
		expect(secondResult).toEqual({ action: "transform", text: "/outer expanded-two" });
		expect(skillLoads).toBe(1);
		expect(templateLoads).toBe(1);

		await harness.fireEvent("session_start", { type: "session_start" });
		const [thirdResult] = await harness.fireEvent("input", { text: "/outer /tmpl three" });
		expect(thirdResult).toEqual({ action: "transform", text: "/outer expanded-three" });
		expect(skillLoads).toBe(2);
		expect(templateLoads).toBe(2);
	});
});
