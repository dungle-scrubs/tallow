/**
 * E2E: Tool and command conflict detection.
 *
 * Runs each profile and checks for duplicate registrations across
 * tools, commands, and flags. Catches collisions that would be invisible
 * in unit tests which load extensions in isolation.
 */

import { afterEach, describe, it } from "bun:test";
import type { TallowSession } from "../../src/sdk.js";
import {
	createProfileSession,
	getRegisteredCommandNames,
	getRegisteredToolNames,
	type ProfileSession,
} from "./profile-runner.js";
import { CORE_EXTENSIONS, discoverAllExtensionNames, STANDARD_EXTENSIONS } from "./profiles.js";

let session: ProfileSession | undefined;

afterEach(() => {
	session?.dispose();
	session = undefined;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find duplicates in an array and return [name, count] pairs.
 *
 * @param names - Array of strings to check
 * @returns Duplicate entries with their counts
 */
function findDuplicates(names: string[]): [string, number][] {
	const seen = new Map<string, number>();
	for (const name of names) {
		seen.set(name, (seen.get(name) ?? 0) + 1);
	}
	return [...seen.entries()].filter(([, count]) => count > 1);
}

/**
 * Collect all flag names registered across loaded extensions.
 *
 * @param tallow - The tallow session
 * @returns Array of flag name strings
 */
function getRegisteredFlagNames(tallow: TallowSession): string[] {
	const names: string[] = [];
	for (const ext of tallow.extensions.extensions) {
		for (const name of ext.flags.keys()) {
			names.push(name);
		}
	}
	return names;
}

// ── Tests ────────────────────────────────────────────────────────────────────

const profiles = [
	{ name: "core", extensions: CORE_EXTENSIONS },
	{ name: "standard", extensions: STANDARD_EXTENSIONS },
	{ name: "full", extensions: discoverAllExtensionNames() },
] as const;

for (const profile of profiles) {
	describe(`${profile.name} profile — conflict detection`, () => {
		it("has no duplicate tool names", async () => {
			session = await createProfileSession({ extensions: profile.extensions });
			const dupes = findDuplicates(getRegisteredToolNames(session.tallow));

			if (dupes.length > 0) {
				throw new Error(
					`[${profile.name}] Duplicate tools: ${dupes.map(([n, c]) => `${n} (${c}x)`).join(", ")}`
				);
			}
		});

		it("has no duplicate command names", async () => {
			session = await createProfileSession({ extensions: profile.extensions });
			const dupes = findDuplicates(getRegisteredCommandNames(session.tallow));

			if (dupes.length > 0) {
				throw new Error(
					`[${profile.name}] Duplicate commands: ${dupes.map(([n, c]) => `${n} (${c}x)`).join(", ")}`
				);
			}
		});

		it("has no duplicate flag names", async () => {
			session = await createProfileSession({ extensions: profile.extensions });
			const dupes = findDuplicates(getRegisteredFlagNames(session.tallow));

			if (dupes.length > 0) {
				throw new Error(
					`[${profile.name}] Duplicate flags: ${dupes.map(([n, c]) => `${n} (${c}x)`).join(", ")}`
				);
			}
		});

		it("no extension throws during load", async () => {
			session = await createProfileSession({ extensions: profile.extensions });

			if (session.tallow.extensions.errors.length > 0) {
				const details = session.tallow.extensions.errors
					.map((e) => `  ${e.path}: ${e.error}`)
					.join("\n");
				throw new Error(`[${profile.name}] Extension load errors:\n${details}`);
			}
		});
	});
}
