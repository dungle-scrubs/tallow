/**
 * Upstream version check — `/upstream` command.
 *
 * Compares pinned versions of @mariozechner/pi-coding-agent and pi-tui
 * against npm registry. Only registers when packages/tallow-tui/ exists
 * (i.e. inside the tallow dev checkout).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

/** Packages to check against the npm registry. */
const UPSTREAM_PACKAGES = [
	{ name: "@mariozechner/pi-coding-agent", label: "pi-coding-agent" },
	{ name: "@mariozechner/pi-tui", label: "pi-tui" },
] as const;

/** Timeout for npm registry fetch (ms). */
const FETCH_TIMEOUT = 4_000;

/**
 * Fetch the latest published version from the npm registry.
 *
 * @param pkg - Scoped package name (e.g. "@mariozechner/pi-tui")
 * @returns Latest version string, or null on failure
 */
async function fetchLatestVersion(pkg: string): Promise<string | null> {
	try {
		const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { version?: string };
		return data.version ?? null;
	} catch {
		return null;
	}
}

/**
 * Read the pinned version of a dependency from the root package.json.
 * Handles file: references (fork) by reading the fork's package.json.
 *
 * @param pkgJsonPath - Path to package.json
 * @param depName - Dependency name
 * @returns Version string (stripped of range prefixes), or null
 */
function readPinnedVersion(pkgJsonPath: string, depName: string): string | null {
	try {
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		const raw = pkg.dependencies?.[depName] ?? pkg.devDependencies?.[depName];
		if (!raw) return null;
		if (raw.startsWith("file:")) {
			const forkPkg = join(process.cwd(), raw.slice(5), "package.json");
			if (!existsSync(forkPkg)) return null;
			const fork = JSON.parse(readFileSync(forkPkg, "utf-8")) as { version?: string };
			return fork.version ?? null;
		}
		return raw.replace(/^[^0-9]*/, "");
	} catch {
		return null;
	}
}

/**
 * @param pi - Extension API
 */
export default function (pi: ExtensionAPI) {
	// Only register in tallow dev checkout
	if (!existsSync(join(process.cwd(), "packages", "tallow-tui"))) return;

	pi.registerCommand("upstream", {
		description: "Check for upstream pi-coding-agent / pi-tui updates",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			const pkgJsonPath = join(process.cwd(), "package.json");

			const results = await Promise.all(
				UPSTREAM_PACKAGES.map(async ({ name, label }) => {
					const pinned = readPinnedVersion(pkgJsonPath, name);
					if (!pinned) return null;
					const latest = await fetchLatestVersion(name);
					return { label, pinned, latest };
				})
			);

			const parts: string[] = [];
			let hasUpdate = false;
			for (const r of results) {
				if (!r) continue;
				if (!r.latest) {
					parts.push(`${r.label}: ${r.pinned} (unreachable)`);
					hasUpdate = true;
				} else if (r.latest !== r.pinned) {
					parts.push(`${r.label}: ${r.pinned} → ${r.latest}`);
					hasUpdate = true;
				} else {
					parts.push(`${r.label}: ${r.pinned} ✓`);
				}
			}
			ctx.ui.notify(parts.join("  ·  "), hasUpdate ? "warning" : "info");
		},
	});
}
