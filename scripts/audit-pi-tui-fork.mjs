#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";

export const UPSTREAM_REFERENCE_VERSION = "0.67.68";

export const FORK_KEEP_SET = Object.freeze([
	"border styles",
	"loader global defaults and hide sentinel",
	"editor ghost-text and change-listener APIs",
	"minimal reset/render primitives still required by tallow",
]);

export const DELTA_CLASSIFICATIONS = Object.freeze({
	"autocomplete.js": {
		category: "revert",
		note: "No strong tallow-specific dependency found; re-sync to upstream.",
	},
	"border-styles.js": {
		category: "keep",
		note: "Local-only border style primitive not present upstream.",
	},
	"components/bordered-box.js": {
		category: "upstream",
		note: "Generic component that tallow does not clearly require at runtime.",
	},
	"components/cancellable-loader.js": {
		category: "revert",
		note: "Mostly local keybinding drift, not a justified fork surface.",
	},
	"components/editor.js": {
		category: "keep",
		note: "Retain only ghost-text and change-listener APIs required by prompt suggestions.",
	},
	"components/image.js": {
		category: "extract",
		note: "Image file-path and related app behavior should move out of the fork.",
	},
	"components/input.js": {
		category: "revert",
		note: "No clear product-specific reason to keep local divergence.",
	},
	"components/loader.js": {
		category: "keep",
		note: "Loader defaults and hide sentinel are still used by extensions.",
	},
	"components/markdown.js": {
		category: "revert",
		note: "No strong tallow-only requirement found.",
	},
	"components/select-list.js": {
		category: "revert",
		note: "Mostly presentation drift; sync back unless a concrete requirement emerges.",
	},
	"components/settings-list.js": {
		category: "keep",
		note: "Only the submenu layout transition hook is clearly justified; shrink the rest.",
	},
	"components/text.js": {
		category: "revert",
		note: "No meaningful fork-specific behavior identified.",
	},
	"index.js": {
		category: "keep",
		note: "Derived export surface; should shrink automatically as kept APIs shrink.",
	},
	"keybindings.js": {
		category: "revert",
		note: "Large local namespace drift with weak product justification.",
	},
	"keys.js": {
		category: "upstream",
		note: "Audit hunk-by-hunk; keep only proven compatibility fixes and upstream the generic ones.",
	},
	"stdin-buffer.js": {
		category: "revert",
		note: "No tallow-specific need identified.",
	},
	"terminal-image.js": {
		category: "extract",
		note: "Image metadata/layout helpers should move to tallow or upstream ownership.",
	},
	"terminal.js": {
		category: "keep",
		note: "Alternate screen, progress bar, and terminal protocol support still have real consumers.",
	},
	"test-utils/capability-env.js": {
		category: "keep",
		note: "Test-only helper; acceptable to keep locally but not a runtime fork reason.",
	},
	"tui.js": {
		category: "keep",
		note: "Only minimal reset/render primitives should survive long-term; high-risk drift must shrink.",
	},
	"utils.js": {
		category: "extract",
		note: "Hyperlink/file-link helpers are application helpers and should move to tallow.",
	},
});

/**
 * Normalize runtime JS so transport-only differences do not count as fork deltas.
 *
 * @param content - Runtime JS content
 * @returns Normalized JS for semantic comparison
 */
function normalizeJsForAudit(content) {
	const withoutNodeProtocol = content.replace(/"node:/g, '"').replace(/'node:/g, "'");
	return execFileSync("bunx", ["@biomejs/biome", "format", "--stdin-file-path", "audit.js"], {
		encoding: "utf8",
		input: withoutNodeProtocol,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

/**
 * Collect changed runtime JS files between local fork and packed upstream.
 *
 * @param localDist - Local dist directory
 * @param upstreamDist - Packed upstream dist directory
 * @returns Sorted array of changed or local-only runtime files
 */
export function collectRuntimeDelta(localDist, upstreamDist) {
	const deltas = [];
	const stack = [localDist];
	while (stack.length > 0) {
		const currentDir = stack.pop();
		for (const entry of readdirSync(currentDir)) {
			const absolutePath = join(currentDir, entry);
			const rel = relative(localDist, absolutePath);
			const stats = statSync(absolutePath);
			if (stats.isDirectory()) {
				stack.push(absolutePath);
				continue;
			}
			if (!absolutePath.endsWith(".js") || absolutePath.endsWith(".js.map")) {
				continue;
			}
			const upstreamPath = join(upstreamDist, rel);
			try {
				const localContent = normalizeJsForAudit(readFileSync(absolutePath, "utf8"));
				const upstreamContent = normalizeJsForAudit(readFileSync(upstreamPath, "utf8"));
				if (localContent !== upstreamContent) {
					deltas.push(rel);
				}
			} catch {
				deltas.push(rel);
			}
		}
	}
	return deltas.sort();
}

/**
 * Pack the upstream npm package into a temp directory and return its dist path.
 *
 * @returns Temporary package root and dist path
 */
export function packUpstream() {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-tui-audit-"));
	execFileSync("npm", ["pack", `@mariozechner/pi-tui@${UPSTREAM_REFERENCE_VERSION}`], {
		cwd: tempRoot,
		encoding: "utf-8",
		stdio: "pipe",
	});
	execFileSync("tar", ["-xf", `mariozechner-pi-tui-${UPSTREAM_REFERENCE_VERSION}.tgz`], {
		cwd: tempRoot,
		encoding: "utf-8",
		stdio: "pipe",
	});
	return {
		tempRoot,
		upstreamDist: join(tempRoot, "package", "dist"),
	};
}

/**
 * Build a readable markdown report from delta rows.
 *
 * @param deltas - Runtime delta file list
 * @returns Markdown report string
 */
export function renderMarkdownReport(deltas) {
	const rows = deltas
		.map((file) => {
			const meta = DELTA_CLASSIFICATIONS[file];
			return `| \`${file}\` | ${meta.category} | ${meta.note} |`;
		})
		.join("\n");
	return [
		"# pi-tui Fork Audit",
		"",
		`Upstream reference version: \`${UPSTREAM_REFERENCE_VERSION}\``,
		"",
		"## Long-term keep set",
		"",
		...FORK_KEEP_SET.map((item) => `- ${item}`),
		"",
		"## Runtime delta classification",
		"",
		"| File | Category | Note |",
		"|------|----------|------|",
		rows,
		"",
	].join("\n");
}

/**
 * Main CLI entry point.
 *
 * @returns Exit code
 */
function main() {
	const args = process.argv.slice(2);
	const markdownIndex = args.indexOf("--write-markdown");
	const markdownPath = markdownIndex >= 0 ? args[markdownIndex + 1] : undefined;
	const { tempRoot, upstreamDist } = packUpstream();
	try {
		const localDist = join(process.cwd(), "packages", "tallow-tui", "dist");
		const deltas = collectRuntimeDelta(localDist, upstreamDist);
		const unclassified = deltas.filter((file) => !(file in DELTA_CLASSIFICATIONS));
		if (unclassified.length > 0) {
			throw new Error(`Unclassified delta files: ${unclassified.join(", ")}`);
		}
		const output = {
			deltaCount: deltas.length,
			deltas: deltas.map((file) => ({ file, ...DELTA_CLASSIFICATIONS[file] })),
			keepSet: [...FORK_KEEP_SET],
			upstreamVersion: UPSTREAM_REFERENCE_VERSION,
		};
		if (markdownPath) {
			writeFileSync(markdownPath, renderMarkdownReport(deltas), "utf-8");
		}
		console.log(JSON.stringify(output, null, 2));
	} finally {
		rmSync(tempRoot, { force: true, recursive: true });
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
