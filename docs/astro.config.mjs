import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

/** Read all extension.json files and group by category */
function buildExtensionSidebar() {
	const extDir = join(import.meta.dirname, "..", "extensions");
	const groups = new Map();

	for (const entry of readdirSync(extDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
		const jsonPath = join(extDir, entry.name, "extension.json");
		try {
			const meta = JSON.parse(readFileSync(jsonPath, "utf-8"));
			const category = meta.category ?? "other";
			if (!groups.has(category)) groups.set(category, []);
			groups.get(category).push({
				label: meta.name,
				slug: `extensions/${meta.name}`,
			});
		} catch {
			// skip dirs without extension.json
		}
	}

	// Sort items within each group
	for (const items of groups.values()) {
		items.sort((a, b) => a.label.localeCompare(b.label));
	}

	// Category display order and labels
	const categoryOrder = [
		["tool", "Tools"],
		["ui", "UI & Display"],
		["utility", "Utilities"],
		["command", "Commands"],
		["integration", "Integrations"],
		["language-support", "Language Support"],
		["context", "Context"],
		// "alias" excluded — covered by the manual Aliases page
	];

	const sidebar = [];
	for (const [key, label] of categoryOrder) {
		const items = groups.get(key);
		if (items?.length) {
			sidebar.push({ label, items });
		}
	}

	// Catch any uncategorized (skip "alias" — covered by manual Aliases page)
	const excludedCategories = new Set(["alias", ...categoryOrder.map(([k]) => k)]);
	for (const [key, items] of groups) {
		if (!excludedCategories.has(key) && items.length) {
			sidebar.push({ label: key, items });
		}
	}

	return sidebar;
}

export default defineConfig({
	site: "https://tallow.dungle-scrubs.com",
	integrations: [
		starlight({
			title: "tallow",
			favicon: "/favicon.ico",
			description:
				"An extensible, multi-model coding agent for your terminal. 30+ extensions, 34 themes, multi-agent teams, and lifecycle hooks. Compatible with Claude Code.",
			head: [
				{
					tag: "meta",
					attrs: { property: "og:image", content: "https://tallow.dungle-scrubs.com/og-image.png" },
				},
				{ tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
				{ tag: "meta", attrs: { property: "og:image:height", content: "630" } },
			],
			social: [
				{ icon: "github", label: "GitHub", href: "https://github.com/dungle-scrubs/tallow" },
			],
			customCss: ["./src/styles/custom.css"],
			sidebar: [
				{
					label: "Getting Started",
					items: [
						{ label: "Introduction", slug: "getting-started/introduction" },
						{ label: "Installation", slug: "getting-started/installation" },
						{ label: "Icons", slug: "getting-started/icons" },
						{ label: "Packages", slug: "getting-started/packages" },
					],
				},
				{
					label: "Guides",
					items: [
						{
							label: "Using tallow in Claude Code projects",
							slug: "guides/coming-from-claude-code",
						},
						{
							label: "WezTerm Integration",
							slug: "guides/wezterm-integration",
						},
					],
				},
				{
					label: "Extensions",
					items: [
						{ label: "Overview", slug: "extensions/overview" },
						{ label: "Aliases", slug: "extensions/aliases" },
						...buildExtensionSidebar(),
					],
				},
				{
					label: "Development",
					items: [{ label: "Creating Extensions", slug: "development/creating-extensions" }],
				},
				{
					label: "Roadmap",
					items: [{ label: "What's Next", slug: "roadmap" }],
				},
				{
					label: "Changelog",
					items: [{ label: "All Changes", slug: "changelog" }],
				},
			],
		}),
	],
});
