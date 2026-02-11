/** Metadata about an indexed session. */
export interface SessionMeta {
	id: string;
	path: string;
	cwd: string;
	project: string;
	startedAt: string;
	messageCount: number;
	firstMessage: string;
	lastIndexedLine: number;
	fileMtime: number;
}

/** A conversation turn (user message paired with assistant response). */
export interface Turn {
	sessionId: string;
	turnIndex: number;
	userText: string;
	assistantText: string;
	timestamp: string;
}

/** A search result with surrounding context turns. */
export interface SearchResult {
	sessionId: string;
	date: string;
	project: string;
	firstMessage: string;
	matchedTurn: { userText: string; assistantText: string; turnIndex: number };
	contextBefore: { userText: string; assistantText: string } | null;
	contextAfter: { userText: string; assistantText: string } | null;
	score: number;
}

/** Options for searching sessions. */
export interface SearchOptions {
	project?: string;
	dateFrom?: string;
	dateTo?: string;
	limit?: number;
}
