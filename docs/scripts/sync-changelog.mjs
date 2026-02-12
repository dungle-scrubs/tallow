/**
 * Build-time sync script: copies root CHANGELOG.md into the Starlight
 * content collection with frontmatter prepended.
 *
 * Runs automatically via npm pre-scripts (predev, prebuild).
 * The generated file is gitignored — source of truth is root CHANGELOG.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const source = readFileSync(join(root, "CHANGELOG.md"), "utf-8");

// Strip the "# Changelog" H1 — Starlight generates its own from frontmatter title
const content = source.replace(/^# Changelog\n*/m, "");

const frontmatter = `---
title: Changelog
description: All notable changes to tallow, following Keep a Changelog.
---

`;

const outPath = join(import.meta.dirname, "..", "src", "content", "docs", "changelog.md");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, frontmatter + content);
