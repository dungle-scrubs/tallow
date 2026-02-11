/**
 * Session indexer — builds and queries an FTS5 index over tallow session JSONL files.
 *
 * Stores a SQLite database alongside session files at ~/.tallow/sessions/index.db.
 * Incrementally indexes new/changed sessions by tracking file mtime.
 * Pairs consecutive user+assistant messages into "turns" for search.
 *
 * Uses better-sqlite3 (native Node.js addon) with FTS5 + porter stemming.
 */

import { createReadStream, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import type { SearchOptions, SearchResult, SessionMeta } from "./types.js";

/** Extracted text from a message event in the session JSONL. */
interface ParsedMessage {
	role: "user" | "assistant";
	text: string;
	timestamp: string;
}

/**
 * FTS5-backed session indexer using better-sqlite3.
 *
 * @example
 * ```typescript
 * const indexer = new SessionIndexer("~/.tallow/sessions/index.db");
 * await indexer.indexSessions("~/.tallow/sessions", "current-session-id");
 * const results = indexer.search("visual sell design", { project: "rack-warehouse" });
 * ```
 */
export class SessionIndexer {
	private db: Database.Database;

	/**
	 * @param dbPath - Path to the SQLite database file
	 */
	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("synchronous = NORMAL");
		this.ensureSchema();
	}

	/** Create tables and FTS5 virtual table if they don't exist. */
	private ensureSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				path TEXT NOT NULL,
				cwd TEXT,
				project TEXT,
				started_at TEXT NOT NULL,
				message_count INTEGER DEFAULT 0,
				first_message TEXT,
				last_indexed_line INTEGER DEFAULT 0,
				file_mtime REAL
			);

			CREATE TABLE IF NOT EXISTS turns (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				turn_index INTEGER NOT NULL,
				user_text TEXT,
				assistant_text TEXT,
				timestamp TEXT,
				UNIQUE(session_id, turn_index)
			);

			CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
				user_text,
				assistant_text,
				content=turns,
				content_rowid=id,
				tokenize='porter unicode61'
			);

			CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
				INSERT INTO turns_fts(rowid, user_text, assistant_text)
				VALUES (new.id, new.user_text, new.assistant_text);
			END;

			CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
				INSERT INTO turns_fts(turns_fts, rowid, user_text, assistant_text)
				VALUES ('delete', old.id, old.user_text, old.assistant_text);
			END;

			CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
				INSERT INTO turns_fts(turns_fts, rowid, user_text, assistant_text)
				VALUES ('delete', old.id, old.user_text, old.assistant_text);
				INSERT INTO turns_fts(rowid, user_text, assistant_text)
				VALUES (new.id, new.user_text, new.assistant_text);
			END;
		`);
	}

	/**
	 * Scan sessions directory and index new/changed JSONL files.
	 *
	 * @param sessionsDir - Directory containing .jsonl session files
	 * @param excludeSessionId - Current session ID to skip (already in context)
	 */
	async indexSessions(sessionsDir: string, excludeSessionId?: string): Promise<void> {
		const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));

		for (const file of files) {
			const filePath = join(sessionsDir, file);
			const stat = statSync(filePath);
			const mtime = stat.mtimeMs;

			// Check if already indexed and unchanged
			const existing = this.db
				.prepare("SELECT id, file_mtime, last_indexed_line FROM sessions WHERE path = ?")
				.get(filePath) as { id: string; file_mtime: number; last_indexed_line: number } | undefined;

			if (existing) {
				// Skip if file hasn't changed
				if (existing.file_mtime === mtime) continue;

				// Skip current session
				if (existing.id === excludeSessionId) continue;

				// File changed — re-index completely (delete + re-insert)
				this.db.prepare("DELETE FROM turns WHERE session_id = ?").run(existing.id);
				this.db.prepare("DELETE FROM sessions WHERE id = ?").run(existing.id);
			}

			await this.indexFile(filePath, mtime, excludeSessionId);
		}
	}

	/**
	 * Parse and index a single session JSONL file.
	 *
	 * @param filePath - Path to the JSONL file
	 * @param mtime - File modification time in ms
	 * @param excludeSessionId - Skip if this is the current session
	 */
	private async indexFile(
		filePath: string,
		mtime: number,
		excludeSessionId?: string
	): Promise<void> {
		const messages: ParsedMessage[] = [];
		let sessionId: string | null = null;
		let cwd: string | null = null;
		let startedAt: string | null = null;
		let lineCount = 0;

		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf-8" }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		for await (const line of rl) {
			lineCount++;
			if (!line.trim()) continue;

			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}

			// Session header
			if (event.type === "session") {
				sessionId = event.id as string;
				cwd = event.cwd as string;
				startedAt = event.timestamp as string;

				// Skip current session
				if (sessionId === excludeSessionId) return;
				continue;
			}

			// Message events
			if (event.type === "message") {
				const msg = event.message as Record<string, unknown> | undefined;
				if (!msg) continue;

				const role = msg.role as string;
				if (role !== "user" && role !== "assistant") continue;

				const content = msg.content as Array<Record<string, unknown>> | undefined;
				if (!content || !Array.isArray(content)) continue;

				const textParts: string[] = [];
				for (const block of content) {
					// For user: all text blocks. For assistant: only text (skip thinking, toolCall)
					if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
						textParts.push(block.text.trim());
					}
				}

				const text = textParts.join("\n").trim();
				if (!text) continue;

				const timestamp = (msg.timestamp as string) ?? (event.timestamp as string) ?? "";
				messages.push({ role: role as "user" | "assistant", text, timestamp: String(timestamp) });
			}
		}

		if (!sessionId || !startedAt) return;

		// Pair messages into turns: one user message + ALL assistant text until the next user message.
		// Sessions often have long chains of assistant→toolResult→assistant→... between user messages.
		// We concatenate all assistant text blocks in that span into a single turn.
		const turns: Array<{
			userText: string;
			assistantText: string;
			timestamp: string;
		}> = [];

		let pendingUser: ParsedMessage | null = null;
		let assistantParts: string[] = [];

		for (const msg of messages) {
			if (msg.role === "user") {
				// Flush previous turn
				if (pendingUser) {
					turns.push({
						userText: pendingUser.text,
						assistantText: assistantParts.join("\n\n"),
						timestamp: pendingUser.timestamp,
					});
				}
				pendingUser = msg;
				assistantParts = [];
			} else if (msg.role === "assistant") {
				assistantParts.push(msg.text);
			}
		}
		// Flush final turn
		if (pendingUser) {
			turns.push({
				userText: pendingUser.text,
				assistantText: assistantParts.join("\n\n"),
				timestamp: pendingUser.timestamp,
			});
		}

		if (turns.length === 0) return;

		const project = cwd ? basename(cwd) : "";
		const firstMessage = turns[0].userText.slice(0, 200);

		// Insert in a transaction for speed
		const insertSession = this.db.prepare(`
			INSERT INTO sessions (id, path, cwd, project, started_at, message_count, first_message, last_indexed_line, file_mtime)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		const insertTurn = this.db.prepare(`
			INSERT INTO turns (session_id, turn_index, user_text, assistant_text, timestamp)
			VALUES (?, ?, ?, ?, ?)
		`);

		const transaction = this.db.transaction(() => {
			insertSession.run(
				sessionId,
				filePath,
				cwd,
				project,
				startedAt,
				messages.length,
				firstMessage,
				lineCount,
				mtime
			);
			for (let i = 0; i < turns.length; i++) {
				const turn = turns[i];
				insertTurn.run(sessionId, i, turn.userText, turn.assistantText, turn.timestamp);
			}
		});

		transaction();
	}

	/**
	 * Search indexed sessions using FTS5 with BM25 ranking.
	 *
	 * @param query - Search query (natural language, tokenized by FTS5)
	 * @param options - Optional filters for project, date range, and result limit
	 * @returns Ranked search results with ±1 context turns
	 */
	search(query: string, options: SearchOptions = {}): SearchResult[] {
		const { project, dateFrom, dateTo, limit = 10 } = options;

		// Build the WHERE clause for metadata filters
		const conditions: string[] = [];
		const params: unknown[] = [query];

		if (project) {
			conditions.push("s.project = ?");
			params.push(project);
		}
		if (dateFrom) {
			conditions.push("s.started_at >= ?");
			params.push(dateFrom);
		}
		if (dateTo) {
			conditions.push("s.started_at <= ?");
			params.push(dateTo);
		}

		const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
		params.push(limit);

		const sql = `
			SELECT
				t.id AS turn_rowid,
				t.session_id,
				t.turn_index,
				t.user_text,
				t.assistant_text,
				t.timestamp AS turn_timestamp,
				s.started_at,
				s.project,
				s.first_message,
				s.cwd,
				rank
			FROM turns_fts
			JOIN turns t ON t.id = turns_fts.rowid
			JOIN sessions s ON s.id = t.session_id
			WHERE turns_fts MATCH ?
			${whereClause}
			ORDER BY rank
			LIMIT ?
		`;

		const rows = this.db.prepare(sql).all(...params) as Array<{
			turn_rowid: number;
			session_id: string;
			turn_index: number;
			user_text: string;
			assistant_text: string;
			turn_timestamp: string;
			started_at: string;
			project: string;
			first_message: string;
			cwd: string;
			rank: number;
		}>;

		// Fetch ±1 context turns for each result
		const getContext = this.db.prepare(
			"SELECT user_text, assistant_text FROM turns WHERE session_id = ? AND turn_index = ?"
		);

		return rows.map((row) => {
			const before = getContext.get(row.session_id, row.turn_index - 1) as
				| {
						user_text: string;
						assistant_text: string;
				  }
				| undefined;
			const after = getContext.get(row.session_id, row.turn_index + 1) as
				| {
						user_text: string;
						assistant_text: string;
				  }
				| undefined;

			return {
				sessionId: row.session_id,
				date: row.started_at,
				project: row.project,
				firstMessage: row.first_message,
				matchedTurn: {
					userText: row.user_text,
					assistantText: row.assistant_text,
					turnIndex: row.turn_index,
				},
				contextBefore: before
					? { userText: before.user_text, assistantText: before.assistant_text }
					: null,
				contextAfter: after
					? { userText: after.user_text, assistantText: after.assistant_text }
					: null,
				score: row.rank,
			};
		});
	}

	/**
	 * List indexed sessions with metadata.
	 *
	 * @param options - Optional filters for project and date range
	 * @returns Array of session metadata sorted by most recent first
	 */
	listSessions(options: SearchOptions = {}): SessionMeta[] {
		const { project, dateFrom, dateTo, limit = 50 } = options;

		const conditions: string[] = [];
		const params: unknown[] = [];

		if (project) {
			conditions.push("project = ?");
			params.push(project);
		}
		if (dateFrom) {
			conditions.push("started_at >= ?");
			params.push(dateFrom);
		}
		if (dateTo) {
			conditions.push("started_at <= ?");
			params.push(dateTo);
		}

		const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		params.push(limit);

		const sql = `
			SELECT id, path, cwd, project, started_at, message_count, first_message, last_indexed_line, file_mtime
			FROM sessions
			${whereClause}
			ORDER BY started_at DESC
			LIMIT ?
		`;

		return this.db.prepare(sql).all(...params) as SessionMeta[];
	}

	/** Close the database connection. */
	close(): void {
		this.db.close();
	}
}
