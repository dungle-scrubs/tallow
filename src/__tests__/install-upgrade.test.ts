import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectPackageManager,
	formatBinaryUpgradeGuidance,
	isSourceCheckout,
	resolveBinaryUpgradeGuidance,
} from "../install.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { force: true, recursive: true });
	}
	tempDirs.length = 0;
});

describe("installer upgrade guidance", () => {
	test("detects package manager from npm user agent", () => {
		expect(detectPackageManager("bun/1.3.9 npm/? node/v22.0.0")).toBe("bun");
		expect(detectPackageManager("pnpm/10.0.0 npm/? node/v22.0.0")).toBe("pnpm");
		expect(detectPackageManager("npm/10.8.2 node/v22.0.0 darwin arm64")).toBe("npm");
		expect(detectPackageManager(undefined)).toBeUndefined();
	});

	test("treats .git checkouts as source installs", () => {
		const packageDir = mkdtempSync(join(tmpdir(), "tallow-install-source-"));
		tempDirs.push(packageDir);
		mkdirSync(join(packageDir, ".git"));

		expect(isSourceCheckout(packageDir)).toBe(true);

		const guidance = resolveBinaryUpgradeGuidance({
			packageDir,
			packageManager: "npm",
		});

		expect(guidance.kind).toBe("source_checkout");
		expect(guidance.commands).toEqual(["git pull", "bun install", "bun run build"]);
	});

	test("prefers an exact package-manager command when available", () => {
		const packageDir = mkdtempSync(join(tmpdir(), "tallow-install-published-"));
		tempDirs.push(packageDir);

		const guidance = resolveBinaryUpgradeGuidance({
			packageDir,
			packageManager: "pnpm",
		});

		expect(guidance.kind).toBe("package_manager");
		expect(guidance.commands).toEqual(["pnpm add -g @dungle-scrubs/tallow@latest"]);
		expect(formatBinaryUpgradeGuidance(guidance)).toContain(
			"pnpm add -g @dungle-scrubs/tallow@latest"
		);
	});

	test("falls back to manual examples when install method is unknown", () => {
		const packageDir = mkdtempSync(join(tmpdir(), "tallow-install-unknown-"));
		tempDirs.push(packageDir);

		const guidance = resolveBinaryUpgradeGuidance({ packageDir });

		expect(guidance.kind).toBe("unknown");
		expect(guidance.commands).toEqual([
			"npm install -g @dungle-scrubs/tallow@latest",
			"pnpm add -g @dungle-scrubs/tallow@latest",
			"bun add -g @dungle-scrubs/tallow@latest",
		]);
	});
});
