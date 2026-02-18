import { describe, expect, it } from "bun:test";

/**
 * Tests for the tallow-specific routing orchestration (loadRoutingConfig).
 *
 * selectModels tests now live in the synapse package.
 * routeModel tests live in auto-cheap-model.test.ts.
 */

const { loadRoutingConfig } = await import("../model-router.js");

describe("loadRoutingConfig", () => {
	it("returns defaults when settings file is missing", () => {
		const config = loadRoutingConfig();
		expect(config.enabled).toBe(true);
		expect(config.primaryType).toBe("code");
		expect(config.costPreference).toBe("balanced");
	});
});
