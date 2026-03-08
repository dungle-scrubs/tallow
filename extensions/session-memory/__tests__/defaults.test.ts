import { describe, expect, test } from "bun:test";
import { resolveProjectFilter } from "../index.js";

describe("resolveProjectFilter", () => {
	test("prefers an explicit project override", () => {
		expect(resolveProjectFilter("beta", "/Users/kevin/dev/alpha")).toBe("beta");
	});

	test("defaults to the current project basename", () => {
		expect(resolveProjectFilter(undefined, "/Users/kevin/dev/tallow")).toBe("tallow");
	});

	test("trims explicit project filters", () => {
		expect(resolveProjectFilter("  beta  ", "/Users/kevin/dev/alpha")).toBe("beta");
	});

	test("falls back to the current project when the explicit filter is blank", () => {
		expect(resolveProjectFilter("   ", "/Users/kevin/dev/alpha")).toBe("alpha");
	});

	test("returns undefined when cwd cannot produce a project name", () => {
		expect(resolveProjectFilter(undefined, "/")).toBeUndefined();
		expect(resolveProjectFilter(undefined, "   ")).toBeUndefined();
	});
});
