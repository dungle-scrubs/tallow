/**
 * Persistent archive storage for teams-tool.
 *
 * Archives are stored on disk so `team_resume` survives process restarts and
 * session shutdown. Runtime state still uses the in-memory store; this module
 * only handles serialization and persistence of archived snapshots.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../_shared/atomic-write.js";
import { getTallowPath } from "../_shared/tallow-paths.js";
import type { ArchivedTeam, TeamMessage } from "./store.js";

interface SerializedTeamMessage {
	readonly content: string;
	readonly from: string;
	readonly readBy: readonly string[];
	readonly timestamp: number;
	readonly to: string;
}

interface SerializedArchivedTeam {
	readonly archivedAt: number;
	readonly messages: readonly SerializedTeamMessage[];
	readonly name: string;
	readonly taskCounter: number;
	readonly tasks: ArchivedTeam["tasks"];
}

/**
 * Resolve the directory that stores archived teams.
 *
 * @returns Absolute archive directory path under the active tallow home
 */
export function getTeamArchivesDir(): string {
	return getTallowPath("team-archives");
}

/**
 * Ensure the archive directory exists before reading or writing.
 *
 * @returns Archive directory path
 */
function ensureTeamArchivesDir(): string {
	const dir = getTeamArchivesDir();
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Resolve the archive file path for one team name.
 *
 * @param teamName - Team name to encode into a stable file name
 * @returns Absolute JSON file path
 */
function getArchiveFilePath(teamName: string): string {
	return join(ensureTeamArchivesDir(), `${encodeURIComponent(teamName)}.json`);
}

/**
 * Convert a runtime TeamMessage into a JSON-safe form.
 *
 * @param message - Runtime message with Set-based read tracking
 * @returns Serializable message record
 */
function serializeTeamMessage(message: TeamMessage): SerializedTeamMessage {
	return {
		content: message.content,
		from: message.from,
		readBy: [...message.readBy].sort(),
		timestamp: message.timestamp,
		to: message.to,
	};
}

/**
 * Convert an archived team into a JSON-safe form.
 *
 * @param archived - Archived team snapshot from the runtime store
 * @returns Serializable archive payload
 */
function serializeArchivedTeam(archived: ArchivedTeam): SerializedArchivedTeam {
	return {
		archivedAt: archived.archivedAt,
		messages: archived.messages.map(serializeTeamMessage),
		name: archived.name,
		taskCounter: archived.taskCounter,
		tasks: archived.tasks,
	};
}

/**
 * Convert a serialized message back into the runtime representation.
 *
 * @param message - JSON-parsed message payload
 * @returns Runtime message with Set-based read tracking
 */
function deserializeTeamMessage(message: SerializedTeamMessage): TeamMessage {
	return {
		content: message.content,
		from: message.from,
		readBy: new Set(message.readBy),
		timestamp: message.timestamp,
		to: message.to,
	};
}

/**
 * Parse an archived-team JSON payload.
 *
 * @param raw - Raw JSON string from disk
 * @returns Parsed archive, or undefined when malformed
 */
function deserializeArchivedTeam(raw: string): ArchivedTeam | undefined {
	try {
		const parsed = JSON.parse(raw) as Partial<SerializedArchivedTeam>;
		if (
			typeof parsed.name !== "string" ||
			typeof parsed.archivedAt !== "number" ||
			typeof parsed.taskCounter !== "number" ||
			!Array.isArray(parsed.tasks) ||
			!Array.isArray(parsed.messages)
		) {
			return undefined;
		}
		return {
			archivedAt: parsed.archivedAt,
			messages: parsed.messages.map((message) => deserializeTeamMessage(message)),
			name: parsed.name,
			taskCounter: parsed.taskCounter,
			tasks: parsed.tasks,
		};
	} catch {
		return undefined;
	}
}

/**
 * Persist one archived team snapshot to disk.
 *
 * @param archived - Archived team snapshot to write
 * @returns Nothing
 */
export function writeArchivedTeamToDisk(archived: ArchivedTeam): void {
	const filePath = getArchiveFilePath(archived.name);
	atomicWriteFileSync(filePath, JSON.stringify(serializeArchivedTeam(archived), null, 2));
}

/**
 * Delete one archived team snapshot from disk.
 *
 * @param teamName - Team whose archive should be removed
 * @returns Nothing
 */
export function deleteArchivedTeamFromDisk(teamName: string): void {
	const filePath = getArchiveFilePath(teamName);
	if (!existsSync(filePath)) return;
	unlinkSync(filePath);
}

/**
 * Load one archived team snapshot from disk.
 *
 * @param teamName - Team whose archive should be read
 * @returns Archived snapshot, or undefined when missing or malformed
 */
export function loadArchivedTeamFromDisk(teamName: string): ArchivedTeam | undefined {
	const filePath = getArchiveFilePath(teamName);
	if (!existsSync(filePath)) return undefined;
	try {
		return deserializeArchivedTeam(readFileSync(filePath, "utf-8"));
	} catch {
		return undefined;
	}
}

/**
 * Load all archived team snapshots from disk.
 *
 * Malformed files are skipped rather than crashing archive discovery.
 * Results are sorted newest-first for status listings.
 *
 * @returns Archived team snapshots persisted on disk
 */
export function loadAllArchivedTeamsFromDisk(): ArchivedTeam[] {
	const dir = ensureTeamArchivesDir();
	const archives: ArchivedTeam[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		try {
			const archive = deserializeArchivedTeam(readFileSync(join(dir, entry.name), "utf-8"));
			if (!archive) continue;
			archives.push(archive);
		} catch {
			// Skip unreadable archive files instead of breaking discovery.
		}
	}
	return archives.sort((left, right) => right.archivedAt - left.archivedAt);
}
