import { describe, expect, test } from "bun:test";
import { normalizeStartupProfile, resolveStartupProfile } from "../startup-profile.js";

describe("startup profile resolution", () => {
	test("normalizes undefined profile to interactive", () => {
		expect(normalizeStartupProfile(undefined)).toBe("interactive");
	});

	test("keeps explicit headless profile", () => {
		expect(normalizeStartupProfile("headless")).toBe("headless");
	});

	test("resolves print-path interactive invocations to headless", () => {
		expect(resolveStartupProfile({ hasPrintInput: true, mode: "interactive" })).toBe("headless");
	});

	test("resolves json and rpc modes to headless", () => {
		expect(resolveStartupProfile({ hasPrintInput: false, mode: "json" })).toBe("headless");
		expect(resolveStartupProfile({ hasPrintInput: false, mode: "rpc" })).toBe("headless");
	});

	test("resolves pure interactive TUI to interactive", () => {
		expect(resolveStartupProfile({ hasPrintInput: false, mode: "interactive" })).toBe(
			"interactive"
		);
	});
});
