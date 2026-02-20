import { describe, expect, test } from "bun:test";
import {
	createRuntimePathProvider,
	createStaticRuntimePathProvider,
} from "../runtime-path-provider.js";

describe("runtime path provider", () => {
	test("builds expected pid and trust paths from home resolver", () => {
		const provider = createRuntimePathProvider(() => "/tmp/tallow-home");

		expect(provider.getHomeDir()).toBe("/tmp/tallow-home");
		expect(provider.getRunDir()).toBe("/tmp/tallow-home/run");
		expect(provider.getLegacyPidFilePath()).toBe("/tmp/tallow-home/run/pids.json");
		expect(provider.getSessionPidDir()).toBe("/tmp/tallow-home/run/pids");
		expect(provider.getTrustDir()).toBe("/tmp/tallow-home/trust");
		expect(provider.getProjectTrustStorePath()).toBe("/tmp/tallow-home/trust/projects.json");
	});

	test("re-reads resolver values on each call", () => {
		let home = "/tmp/home-a";
		const provider = createRuntimePathProvider(() => home);

		expect(provider.getSessionPidDir()).toBe("/tmp/home-a/run/pids");
		home = "/tmp/home-b";
		expect(provider.getSessionPidDir()).toBe("/tmp/home-b/run/pids");
	});

	test("supports static providers for deterministic tests", () => {
		const provider = createStaticRuntimePathProvider("/tmp/static-home");
		expect(provider.getLegacyPidFilePath()).toBe("/tmp/static-home/run/pids.json");
	});

	test("throws for empty runtime home values", () => {
		const provider = createRuntimePathProvider(() => "");
		expect(() => provider.getHomeDir()).toThrow("non-empty home directory");
	});
});
