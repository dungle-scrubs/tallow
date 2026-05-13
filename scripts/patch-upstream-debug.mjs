// biome-ignore-all lint/suspicious/noTemplateCurlyInString: patch fixtures intentionally contain upstream template-literal source

/**
 * Patch upstream pi-coding-agent dist files after install.
 *
 * 1. Remove debug console.error/trace calls left in pi-coding-agent dist.
 *    These COMPACTION_DEBUG lines print to stderr on every prompt, bleeding
 *    into the TUI as red text.
 *
 * 2. Fix generateTurnPrefixSummary() to pass reasoning:"high" when
 *    model.reasoning is true — mirroring what generateSummary() does.
 *    Without this, pi-ai's OpenRouter handler sends
 *    `reasoning: { effort: "none" }` which MiniMax rejects:
 *    "Reasoning is mandatory for this endpoint and cannot be disabled."
 *
 * 3. Add OpenAI Codex WebSocket payload diagnostics and preflight fallback.
 *    Close code 1009 means the WebSocket frame was too large; pi-ai's stock
 *    error hides the payload size and, in auto mode, fails after the socket has
 *    already started instead of falling back to SSE.
 *
 * Runs as a postinstall hook so patches survive `bun install`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

// ── Part 1: Debug console removal ────────────────────────────────────────────

const DEBUG_TARGETS = [
	"node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js",
	"node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js",
];

const DEBUG_PATTERNS = [
	/(?<!\/\/ )console\.error\('\[COMPACTION_DEBUG]/g,
	/(?<!\/\/ )console\.trace\('\[COMPACTION_DEBUG]/g,
];

// ── Part 2: MiniMax reasoning fix ─────────────────────────────────────────────

/**
 * The buggy pattern in generateTurnPrefixSummary:
 * passes no reasoning param, causing pi-ai OpenRouter handler to send
 * reasoning: { effort: "none" } which MiniMax rejects.
 *
 * The fixed pattern mirrors generateSummary()'s approach.
 */
const MINIMAX_COMPACTION_PATH =
	"node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js";

const MINIMAX_BUGGY = `const response = await completeSimple(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, { maxTokens, signal, apiKey });`;

const MINIMAX_FIXED = `const completionOptions = model.reasoning
        ? { maxTokens, signal, apiKey, reasoning: "high" }
        : { maxTokens, signal, apiKey };
    const response = await completeSimple(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, completionOptions);`;

// ── Part 3: OpenAI Codex WebSocket payload diagnostics ───────────────────────

const CODEX_WEBSOCKET_PATH =
	"node_modules/@mariozechner/pi-ai/dist/providers/openai-codex-responses.js";

const CODEX_WEBSOCKET_SENTINEL = "TALLOW_CODEX_WEBSOCKET_PAYLOAD_DIAGNOSTICS_PATCHED";

const CODEX_WEBSOCKET_ANCHOR = `const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const websocketSessionCache = new Map();
const websocketDebugStats = new Map();`;

const CODEX_WEBSOCKET_HELPERS = `const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const TALLOW_WEBSOCKET_TOO_LARGE_CLOSE_CODE = 1009;
const TALLOW_DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const websocketSessionCache = new Map();
const websocketDebugStats = new Map();
const tallowWebSocketRequestPayloadStats = new WeakMap();
// ${CODEX_WEBSOCKET_SENTINEL}
function tallowResolveWebSocketMaxPayloadBytes() {
    const raw = typeof process !== "undefined" ? process.env?.TALLOW_CODEX_WEBSOCKET_MAX_PAYLOAD_BYTES : undefined;
    if (!raw)
        return TALLOW_DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : TALLOW_DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES;
}
function tallowJsonByteLength(value) {
    return Buffer.byteLength(JSON.stringify(value), "utf-8");
}
function tallowFormatBytes(bytes) {
    if (bytes >= 1024 * 1024)
        return \`${"${(bytes / (1024 * 1024)).toFixed(2)}"} MiB\`;
    if (bytes >= 1024)
        return \`${"${(bytes / 1024).toFixed(1)}"} KiB\`;
    return \`${"${bytes}"} B\`;
}
function tallowPayloadStats(requestBody, payloadBytes, maxPayloadBytes) {
    return {
        payloadBytes,
        maxPayloadBytes,
        inputItems: Array.isArray(requestBody.input) ? requestBody.input.length : 0,
        hasPreviousResponseId: typeof requestBody.previous_response_id === "string",
        previousResponseId: requestBody.previous_response_id,
        model: requestBody.model,
        instructionsBytes: typeof requestBody.instructions === "string" ? Buffer.byteLength(requestBody.instructions, "utf-8") : 0,
        inputBytes: tallowJsonByteLength(requestBody.input ?? []),
        toolBytes: tallowJsonByteLength(requestBody.tools ?? []),
    };
}
function tallowLogWebSocketDiagnostic(evt, data) {
    const logger = globalThis.__piDebugLogger;
    if (!logger || typeof logger.log !== "function")
        return;
    try {
        logger.log("model", evt, data);
    }
    catch { }
}
function tallowWebSocketTooLargeError(stats, code, reason) {
    const codeText = typeof code === "number" ? \`WebSocket close ${"${code}"}\` : "WebSocket payload too large";
    const reasonText = typeof reason === "string" && reason.length > 0 ? \` Reason: ${"${reason}"}.\` : "";
    return new Error(\`${"${codeText}"}: OpenAI Codex WebSocket request payload was ${"${tallowFormatBytes(stats.payloadBytes)}"}, above the configured preflight limit of ${"${tallowFormatBytes(stats.maxPayloadBytes)}"}.${"${reasonText}"} Tallow will fall back to SSE in auto transport before the socket starts; if this appeared after the socket started, reduce context or run /compact. Diagnostics: inputItems=${"${stats.inputItems}"}, inputBytes=${"${tallowFormatBytes(stats.inputBytes)}"}, toolBytes=${"${tallowFormatBytes(stats.toolBytes)}"}.\`);
}`;

const CODEX_CLOSE_BUGGY = `function extractWebSocketCloseError(event) {
    if (event && typeof event === "object") {
        const code = "code" in event ? event.code : undefined;
        const reason = "reason" in event ? event.reason : undefined;
        const codeText = typeof code === "number" ? \` ${"${code}"}\` : "";
        const reasonText = typeof reason === "string" && reason.length > 0 ? \` ${"${reason}"}\` : "";
        return new Error(\`WebSocket closed${"${codeText}"}${"${reasonText}"}\`.trim());
    }
    return new Error("WebSocket closed");
}`;

const CODEX_CLOSE_FIXED = `function extractWebSocketCloseError(event, payloadStats) {
    if (event && typeof event === "object") {
        const code = "code" in event ? event.code : undefined;
        const reason = "reason" in event ? event.reason : undefined;
        if (code === TALLOW_WEBSOCKET_TOO_LARGE_CLOSE_CODE) {
            const stats = payloadStats ?? {
                payloadBytes: 0,
                maxPayloadBytes: tallowResolveWebSocketMaxPayloadBytes(),
                inputItems: 0,
                inputBytes: 0,
                toolBytes: 0,
            };
            tallowLogWebSocketDiagnostic("websocket_close_too_large", { ...stats, code, reason });
            return tallowWebSocketTooLargeError(stats, code, reason);
        }
        const codeText = typeof code === "number" ? \` ${"${code}"}\` : "";
        const reasonText = typeof reason === "string" && reason.length > 0 ? \` ${"${reason}"}\` : "";
        return new Error(\`WebSocket closed${"${codeText}"}${"${reasonText}"}\`.trim());
    }
    return new Error("WebSocket closed");
}`;

const CODEX_PARSE_CLOSE_BUGGY = `            failed = extractWebSocketCloseError(event);`;
const CODEX_PARSE_CLOSE_FIXED = `            failed = extractWebSocketCloseError(event, tallowWebSocketRequestPayloadStats.get(socket));`;

const CODEX_SEND_BUGGY = `        socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
        onStart();`;

const CODEX_SEND_FIXED = `        const outboundPayload = { type: "response.create", ...requestBody };
        const outboundPayloadJson = JSON.stringify(outboundPayload);
        const outboundPayloadBytes = Buffer.byteLength(outboundPayloadJson, "utf-8");
        const maxPayloadBytes = tallowResolveWebSocketMaxPayloadBytes();
        const payloadStats = tallowPayloadStats(requestBody, outboundPayloadBytes, maxPayloadBytes);
        tallowWebSocketRequestPayloadStats.set(socket, payloadStats);
        tallowLogWebSocketDiagnostic("websocket_payload", { ...payloadStats, reused });
        if (outboundPayloadBytes > maxPayloadBytes) {
            tallowLogWebSocketDiagnostic("websocket_payload_preflight_too_large", { ...payloadStats, reused });
            throw tallowWebSocketTooLargeError(payloadStats);
        }
        socket.send(outboundPayloadJson);
        onStart();`;

// ── Patch helpers ─────────────────────────────────────────────────────────────

function patchDebug(target) {
	if (!existsSync(target)) return false;

	let content = readFileSync(target, "utf-8");
	let patched = false;

	for (const pattern of DEBUG_PATTERNS) {
		const replacement = content.replace(pattern, (match) => `// ${match}`);
		if (replacement !== content) {
			content = replacement;
			patched = true;
		}
	}

	if (patched) {
		writeFileSync(target, content);
	}
	return patched;
}

function patchMiniMax(target) {
	if (!existsSync(target)) return false;

	const content = readFileSync(target, "utf-8");
	// Only patch if not already fixed (avoid double-patching)
	if (content.includes("MINIMAX_ALREADY_PATCHED")) return false;
	if (!content.includes(MINIMAX_BUGGY)) return false;

	const patched = content.replace(
		MINIMAX_BUGGY,
		`${MINIMAX_FIXED}\n    // MINIMAX_ALREADY_PATCHED`
	);
	writeFileSync(target, patched);
	return true;
}

function patchCodexWebSocketDiagnostics(target) {
	if (!existsSync(target)) return false;

	let content = readFileSync(target, "utf-8");
	if (content.includes(CODEX_WEBSOCKET_SENTINEL)) return false;
	for (const expected of [
		CODEX_WEBSOCKET_ANCHOR,
		CODEX_CLOSE_BUGGY,
		CODEX_PARSE_CLOSE_BUGGY,
		CODEX_SEND_BUGGY,
	]) {
		if (!content.includes(expected)) return false;
	}

	content = content
		.replace(CODEX_WEBSOCKET_ANCHOR, CODEX_WEBSOCKET_HELPERS)
		.replace(CODEX_CLOSE_BUGGY, CODEX_CLOSE_FIXED)
		.replace(CODEX_PARSE_CLOSE_BUGGY, CODEX_PARSE_CLOSE_FIXED)
		.replace(CODEX_SEND_BUGGY, CODEX_SEND_FIXED);

	writeFileSync(target, content);
	return true;
}

// ── Run ───────────────────────────────────────────────────────────────────────

let totalPatched = 0;

for (const target of DEBUG_TARGETS) {
	if (patchDebug(target)) {
		console.log(`Patched COMPACTION_DEBUG in ${target}`);
		totalPatched++;
	}
}

if (patchMiniMax(MINIMAX_COMPACTION_PATH)) {
	console.log(`Patched MiniMax reasoning fix in ${MINIMAX_COMPACTION_PATH}`);
	totalPatched++;
}

if (patchCodexWebSocketDiagnostics(CODEX_WEBSOCKET_PATH)) {
	console.log(`Patched Codex WebSocket diagnostics in ${CODEX_WEBSOCKET_PATH}`);
	totalPatched++;
}

if (totalPatched > 0) {
	console.log(`postinstall: ${totalPatched} file(s) patched`);
}
