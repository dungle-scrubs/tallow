import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT_DIR = process.cwd();

const FILE_LINE_LIMITS: Record<string, number> = {
	"extensions/tasks/index.ts": 120,
	"extensions/teams-tool/index.ts": 120,
	"extensions/tasks/commands/register-tasks-extension.ts": 2200,
	"extensions/teams-tool/tools/register-extension.ts": 1200,
};

const TEAMS_ORCHESTRATION_FILES = new Set([
	"extensions/teams-tool/index.ts",
	"extensions/teams-tool/tools/register-extension.ts",
]);

/**
 * Read file content as UTF-8 text.
 *
 * @param relativePath - Path relative to repo root
 * @returns File content
 */
function readText(relativePath: string): string {
	return readFileSync(join(ROOT_DIR, relativePath), "utf8");
}

/**
 * Count lines in a file.
 *
 * @param relativePath - Path relative to repo root
 * @returns 1-based line count
 */
function countLines(relativePath: string): number {
	return readText(relativePath).split("\n").length;
}

/**
 * Collect all `.ts` files under a directory recursively.
 *
 * @param relativeDir - Directory path relative to repo root
 * @returns Sorted list of relative `.ts` file paths
 */
function collectTypeScriptFiles(relativeDir: string): string[] {
	const base = join(ROOT_DIR, relativeDir);
	const files: string[] = [];
	const stack = [base];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const next = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(next);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
			files.push(relative(ROOT_DIR, next));
		}
	}

	return files.sort();
}

/**
 * Parse import specifiers from a TypeScript module.
 *
 * @param sourceText - Module source code
 * @returns Imported module specifiers
 */
function parseImportSpecifiers(sourceText: string): string[] {
	const specifiers: string[] = [];
	const importRegex = /from\s+["']([^"']+)["']/g;
	for (const match of sourceText.matchAll(importRegex)) {
		specifiers.push(match[1]);
	}
	return specifiers;
}

/**
 * Check whether a module imports dashboard, state, and tools domains together.
 *
 * @param imports - Relative import specifiers from one file
 * @returns True when all three domains are imported
 */
function hasTeamsTripleDomainCoupling(imports: readonly string[]): boolean {
	const hasDashboard = imports.some(
		(spec) => spec.startsWith("../dashboard") || spec.startsWith("./dashboard")
	);
	const hasState = imports.some(
		(spec) =>
			spec.startsWith("../state") ||
			spec.startsWith("./state") ||
			spec.startsWith("../store") ||
			spec.startsWith("./store")
	);
	const hasTools = imports.some(
		(spec) => spec.startsWith("../tools") || spec.startsWith("./tools")
	);
	return hasDashboard && hasState && hasTools;
}

/**
 * Determine whether a tasks-domain file is orchestration-only and allowed to couple domains.
 *
 * @param relativePath - Path relative to repo root
 * @returns True for files intentionally acting as orchestration roots
 */
function isTasksOrchestrationFile(relativePath: string): boolean {
	return (
		relativePath === "extensions/tasks/index.ts" ||
		relativePath === "extensions/tasks/commands/register-tasks-extension.ts"
	);
}

describe("architecture guards", () => {
	test("enforces file-size thresholds for extracted composition roots", () => {
		for (const [filePath, maxLines] of Object.entries(FILE_LINE_LIMITS)) {
			expect(countLines(filePath)).toBeLessThanOrEqual(maxLines);
		}
	});

	test("prevents teams modules from importing dashboard + state + tools together", () => {
		const offenders: string[] = [];
		for (const filePath of collectTypeScriptFiles("extensions/teams-tool")) {
			if (filePath.includes("/__tests__/")) continue;
			if (TEAMS_ORCHESTRATION_FILES.has(filePath)) continue;
			const imports = parseImportSpecifiers(readText(filePath)).filter((spec) =>
				spec.startsWith(".")
			);
			if (hasTeamsTripleDomainCoupling(imports)) offenders.push(filePath);
		}
		expect(offenders).toEqual([]);
	});

	test("keeps tasks domain modules decoupled from command orchestration", () => {
		const offenders: string[] = [];
		for (const filePath of collectTypeScriptFiles("extensions/tasks")) {
			if (filePath.includes("/__tests__/")) continue;
			if (isTasksOrchestrationFile(filePath)) continue;
			const imports = parseImportSpecifiers(readText(filePath)).filter((spec) =>
				spec.startsWith(".")
			);
			if (imports.some((spec) => spec.startsWith("../commands") || spec.startsWith("./commands"))) {
				offenders.push(filePath);
			}
		}
		expect(offenders).toEqual([]);
	});
});
