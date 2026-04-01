import { describe, expect, it } from "bun:test";
import { createIconRegistry, ICON_DEFAULTS, type IconOverrides } from "../index.js";

describe("Icon Registry", () => {
	it("should return default icons when no overrides set", () => {
		const registry = createIconRegistry({});
		expect(registry.getString("success")).toBe("✓");
		expect(registry.getString("error")).toBe("✗");
		expect(registry.getString("pending")).toBe("☐");
		expect(registry.getString("in_progress")).toBe("●");
		expect(registry.getString("idle")).toBe("○");
		expect(registry.getString("waiting")).toBe("⏳");
		expect(registry.getString("active")).toBe("⚡");
		expect(registry.getString("blocked")).toBe("◇");
		expect(registry.getString("unavailable")).toBe("⊘");
		expect(registry.getString("task_list")).toBe("📋");
		expect(registry.getString("comment")).toBe("💬");
	});

	it("should apply user overrides", () => {
		const registry = createIconRegistry({
			success: "✔",
			error: "✘",
		});
		expect(registry.getString("success")).toBe("✔");
		expect(registry.getString("error")).toBe("✘");
		// Non-overridden keys keep defaults
		expect(registry.getString("pending")).toBe("☐");
		expect(registry.getString("in_progress")).toBe("●");
	});

	it("should return undefined for unknown keys via get()", () => {
		const registry = createIconRegistry({});
		// biome-ignore lint/suspicious/noExplicitAny: testing unknown key behavior
		expect(registry.get("nonexistent" as any)).toBeUndefined();
	});

	it("should return fallback from getString() for unknown keys", () => {
		const registry = createIconRegistry({});
		// biome-ignore lint/suspicious/noExplicitAny: testing unknown key behavior
		expect(registry.getString("nonexistent" as any, "?")).toBe("?");
	});

	it("should return empty string from getString() with no fallback for unknown keys", () => {
		const registry = createIconRegistry({});
		// biome-ignore lint/suspicious/noExplicitAny: testing unknown key behavior
		expect(registry.getString("nonexistent" as any)).toBe("");
	});

	it("should ignore null/undefined overrides", () => {
		const overrides = {
			success: undefined,
			error: null,
		} as unknown as IconOverrides;
		const registry = createIconRegistry(overrides);
		expect(registry.getString("success")).toBe("✓");
		expect(registry.getString("error")).toBe("✗");
	});

	it("should have all ICON_DEFAULTS keys accessible", () => {
		const registry = createIconRegistry({});
		for (const key of Object.keys(ICON_DEFAULTS)) {
			expect(registry.get(key as keyof typeof ICON_DEFAULTS)).toBeDefined();
		}
	});
});
