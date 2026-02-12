/**
 * Thin SQLite adapter — uses bun:sqlite in Bun, node:sqlite everywhere else.
 *
 * Presents a unified synchronous interface for SessionIndexer:
 * exec, prepare (get/all/run), transaction, close.
 *
 * @module
 */

/** Runtime detection — Bun exposes this global. */
declare const Bun: unknown;

/** Unified prepared statement interface. */
export interface SqliteStatement {
	/** Fetch the first matching row, or undefined if none. */
	get(...params: unknown[]): Record<string, unknown> | undefined;
	/** Fetch all matching rows. */
	all(...params: unknown[]): Record<string, unknown>[];
	/** Execute a write statement (INSERT/UPDATE/DELETE). */
	run(...params: unknown[]): void;
}

/** Unified database interface. */
export interface SqliteDatabase {
	/** Execute raw SQL (DDL, multi-statement, pragmas). */
	exec(sql: string): void;
	/** Create a prepared statement. */
	prepare(sql: string): SqliteStatement;
	/**
	 * Wrap a function in a BEGIN/COMMIT transaction.
	 *
	 * @param fn - Function to execute inside the transaction
	 * @returns A callable that runs fn inside a transaction
	 */
	transaction<T>(fn: () => T): () => T;
	/** Close the database connection. */
	close(): void;
}

/**
 * Open a SQLite database file using the best available runtime.
 *
 * - Bun → bun:sqlite (native, fast)
 * - Node ≥22.5 → node:sqlite (built-in, no native addon)
 *
 * @param filePath - Path to the .db file (created if missing)
 * @returns Unified SqliteDatabase handle
 * @throws {Error} If neither runtime provides a SQLite module
 */
export function openDatabase(filePath: string): SqliteDatabase {
	if (typeof Bun !== "undefined") {
		return openBun(filePath);
	}
	return openNode(filePath);
}

/**
 * Bun adapter — bun:sqlite has a synchronous API matching our interface.
 *
 * @param filePath - Database file path
 * @returns SqliteDatabase backed by bun:sqlite
 */
function openBun(filePath: string): SqliteDatabase {
	// Dynamic require so Node's resolver doesn't choke on the specifier.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { Database } = require("bun:sqlite") as {
		Database: new (path: string) => BunDatabase;
	};
	const db = new Database(filePath);

	return {
		exec: (sql) => db.exec(sql),
		prepare: (sql) => {
			const stmt = db.prepare(sql);
			return {
				get: (...params) => stmt.get(...params) as Record<string, unknown> | undefined,
				all: (...params) => stmt.all(...params) as Record<string, unknown>[],
				run: (...params) => {
					stmt.run(...params);
				},
			};
		},
		transaction: (fn) => db.transaction(fn) as () => ReturnType<typeof fn>,
		close: () => db.close(),
	};
}

/** Minimal bun:sqlite Database shape (avoids importing bun types at compile time). */
interface BunDatabase {
	exec(sql: string): void;
	prepare(sql: string): BunStatement;
	transaction<T>(fn: () => T): () => T;
	close(): void;
}

/** Minimal bun:sqlite Statement shape. */
interface BunStatement {
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	run(...params: unknown[]): void;
}

/**
 * Node adapter — node:sqlite (DatabaseSync) has a slightly different API:
 * no .pragma(), no .transaction(), .run() returns { changes, lastInsertRowid }.
 *
 * @param filePath - Database file path
 * @returns SqliteDatabase backed by node:sqlite
 */
function openNode(filePath: string): SqliteDatabase {
	let DatabaseSync: new (path: string) => NodeDatabase;
	try {
		// Dynamic import — node:sqlite may not exist on Node <22.5
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mod = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
		DatabaseSync = mod.DatabaseSync;
	} catch {
		throw new Error(
			"SQLite not available. Requires Node >=22.5 (node:sqlite) or Bun runtime. " +
				"On Node 22.x you may need the --experimental-sqlite flag."
		);
	}

	const db = new DatabaseSync(filePath);

	return {
		exec: (sql) => db.exec(sql),
		prepare: (sql) => {
			const stmt = db.prepare(sql);
			return {
				get: (...params) => stmt.get(...params) as Record<string, unknown> | undefined,
				all: (...params) => stmt.all(...params) as Record<string, unknown>[],
				run: (...params) => {
					stmt.run(...params);
				},
			};
		},
		transaction: (fn) => {
			return () => {
				db.exec("BEGIN");
				try {
					const result = fn();
					db.exec("COMMIT");
					return result;
				} catch (err) {
					db.exec("ROLLBACK");
					throw err;
				}
			};
		},
		close: () => db.close(),
	};
}

/** Minimal node:sqlite DatabaseSync shape. */
interface NodeDatabase {
	exec(sql: string): void;
	prepare(sql: string): NodeStatement;
	close(): void;
}

/** Minimal node:sqlite StatementSync shape. */
interface NodeStatement {
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	run(...params: unknown[]): unknown;
}
