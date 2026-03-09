/**
 * OpenTelemetry integration layer for tallow.
 *
 * Provides a zero-cost no-op implementation when telemetry is disabled,
 * and standardized span creation, attribute building, and context propagation
 * when enabled. All spans use the `tallow.*` naming convention.
 *
 * @module
 */

import type {
	Context,
	Span,
	SpanOptions,
	SpanStatusCode,
	Tracer,
	TracerProvider,
} from "@opentelemetry/api";

// ─── Public Types ────────────────────────────────────────────────────────────

/** Telemetry configuration accepted by TallowSessionOptions. */
export interface TallowTelemetryConfig {
	/**
	 * OpenTelemetry TracerProvider to use for span creation.
	 * When provided, enables distributed tracing for this session.
	 */
	readonly tracerProvider: TracerProvider;

	/**
	 * Service name reported in tracer scope metadata.
	 * @default "tallow"
	 */
	readonly serviceName?: string;

	/**
	 * Service version reported in tracer scope metadata.
	 * Falls back to the tallow package version when omitted.
	 */
	readonly serviceVersion?: string;
}

/** Safe span attributes — metadata only, never prompt/payload content. */
export interface TallowSpanAttributes {
	readonly [key: string]: string | number | boolean | undefined;
}

/** Lifecycle span names emitted by tallow. */
export type TallowSpanName =
	| "tallow.compaction"
	| "tallow.model.call"
	| "tallow.model.select"
	| "tallow.prompt"
	| "tallow.session.create"
	| "tallow.subagent.run"
	| "tallow.teammate.run"
	| "tallow.tool.call"
	| "tallow.workspace_transition";

// ─── W3C Trace Context Propagation ──────────────────────────────────────────

/** W3C traceparent header format: version-traceId-spanId-flags. */
const TRACEPARENT_REGEX = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/;

/**
 * Parsed W3C trace context from environment variables.
 * Used for cross-process propagation through CLI and subagent spawns.
 */
export interface TraceContextCarrier {
	readonly traceparent: string;
	readonly tracestate?: string;
}

/**
 * Extract W3C trace context from environment variables.
 *
 * Reads `TRACEPARENT` and optional `TRACESTATE` from the given env object.
 * Returns null if no valid traceparent is present.
 *
 * @param env - Environment object to read from
 * @returns Parsed trace context or null
 */
export function extractTraceContextFromEnv(
	env: Record<string, string | undefined> = process.env
): TraceContextCarrier | null {
	const traceparent = env.TRACEPARENT ?? env.traceparent;
	if (!traceparent || !TRACEPARENT_REGEX.test(traceparent)) {
		return null;
	}

	const tracestate = env.TRACESTATE ?? env.tracestate;
	return { traceparent, tracestate: tracestate || undefined };
}

/**
 * Inject trace context into an environment object for subprocess propagation.
 *
 * Writes `TRACEPARENT` and optionally `TRACESTATE` into the target env object
 * so spawned child processes can continue the trace.
 *
 * @param carrier - Trace context to inject
 * @param env - Target environment object to mutate
 */
export function injectTraceContextToEnv(
	carrier: TraceContextCarrier,
	env: Record<string, string>
): void {
	env.TRACEPARENT = carrier.traceparent;
	if (carrier.tracestate) {
		env.TRACESTATE = carrier.tracestate;
	}
}

// ─── Telemetry Handle ────────────────────────────────────────────────────────

/**
 * Session-scoped telemetry handle returned by `createTelemetryHandle()`.
 *
 * Provides a uniform API for span creation and context propagation regardless
 * of whether telemetry is enabled. When disabled, all methods are zero-cost
 * no-ops that return stub spans.
 */
export interface TelemetryHandle {
	/** Whether real telemetry is active (false when using no-op stubs). */
	readonly enabled: boolean;

	/**
	 * Start a new span under the session's active context.
	 *
	 * @param name - Span name from the tallow span vocabulary
	 * @param attributes - Safe metadata attributes
	 * @param options - Optional OTEL span options (e.g., parent context)
	 * @returns The started span
	 */
	startSpan(name: TallowSpanName, attributes?: TallowSpanAttributes, options?: SpanOptions): Span;

	/**
	 * Run a function within a span, automatically ending the span when done.
	 *
	 * Sets error status and records exceptions on failure before re-throwing.
	 *
	 * @param name - Span name from the tallow span vocabulary
	 * @param attributes - Safe metadata attributes
	 * @param fn - Function to execute within the span
	 * @returns The function's return value
	 */
	withSpan<T>(name: TallowSpanName, attributes: TallowSpanAttributes, fn: (span: Span) => T): T;

	/**
	 * Run an async function within a span, automatically ending the span when done.
	 *
	 * Sets error status and records exceptions on failure before re-throwing.
	 *
	 * @param name - Span name from the tallow span vocabulary
	 * @param attributes - Safe metadata attributes
	 * @param fn - Async function to execute within the span
	 * @returns Promise resolving to the function's return value
	 */
	withSpanAsync<T>(
		name: TallowSpanName,
		attributes: TallowSpanAttributes,
		fn: (span: Span) => Promise<T>
	): Promise<T>;

	/**
	 * Get the current trace context for subprocess propagation.
	 *
	 * Returns a carrier suitable for `injectTraceContextToEnv()`, or null
	 * when telemetry is disabled or no active span exists.
	 *
	 * @returns Trace context carrier or null
	 */
	getTraceContext(): TraceContextCarrier | null;

	/**
	 * Get the underlying OTEL context for in-process child session creation.
	 *
	 * Used by teammate sessions to attach as children of the originating span.
	 * Returns undefined when telemetry is disabled.
	 *
	 * @returns Active OTEL context or undefined
	 */
	getActiveContext(): Context | undefined;

	/**
	 * Get the tracer provider for sharing with in-process child sessions.
	 *
	 * @returns The configured tracer provider, or undefined if disabled
	 */
	getTracerProvider(): TracerProvider | undefined;
}

// ─── No-op Implementation ────────────────────────────────────────────────────

/** Minimal no-op span that satisfies the OTEL Span interface at zero cost. */
const NOOP_SPAN: Span = {
	spanContext() {
		return { traceId: "", spanId: "", traceFlags: 0 };
	},
	setAttribute() {
		return this;
	},
	setAttributes() {
		return this;
	},
	addEvent() {
		return this;
	},
	addLink() {
		return this;
	},
	addLinks() {
		return this;
	},
	setStatus() {
		return this;
	},
	updateName() {
		return this;
	},
	end() {},
	isRecording() {
		return false;
	},
	recordException() {},
};

/** No-op telemetry handle returned when telemetry is not configured. */
const NOOP_HANDLE: TelemetryHandle = {
	enabled: false,
	startSpan() {
		return NOOP_SPAN;
	},
	withSpan<T>(_name: TallowSpanName, _attrs: TallowSpanAttributes, fn: (span: Span) => T): T {
		return fn(NOOP_SPAN);
	},
	async withSpanAsync<T>(
		_name: TallowSpanName,
		_attrs: TallowSpanAttributes,
		fn: (span: Span) => Promise<T>
	): Promise<T> {
		return fn(NOOP_SPAN);
	},
	getTraceContext() {
		return null;
	},
	getActiveContext() {
		return undefined;
	},
	getTracerProvider() {
		return undefined;
	},
};

// ─── Live Implementation ─────────────────────────────────────────────────────

/** Telemetry scope name used for the tallow tracer. */
const TRACER_SCOPE = "tallow";

/**
 * Create a live telemetry handle backed by a real OTEL tracer.
 *
 * @param tracer - OTEL tracer to use for span creation
 * @param api - Dynamic OTEL API import for context management
 * @param provider - The configured tracer provider
 * @param incomingContext - Optional parent context from incoming trace propagation
 * @returns Active telemetry handle
 */
function createLiveHandle(
	tracer: Tracer,
	api: typeof import("@opentelemetry/api"),
	provider: TracerProvider,
	incomingContext?: Context
): TelemetryHandle {
	// Track the "current" context for the session — starts from incoming or root.
	let sessionContext: Context = incomingContext ?? api.context.active();

	return {
		enabled: true,

		startSpan(
			name: TallowSpanName,
			attributes?: TallowSpanAttributes,
			options?: SpanOptions
		): Span {
			const ctx = options?.root ? api.ROOT_CONTEXT : sessionContext;
			const span = tracer.startSpan(name, { ...options, attributes }, ctx);
			// Update session context so subsequent spans nest under this one.
			sessionContext = api.trace.setSpan(sessionContext, span);
			return span;
		},

		withSpan<T>(name: TallowSpanName, attributes: TallowSpanAttributes, fn: (span: Span) => T): T {
			const parentContext = sessionContext;
			const span = tracer.startSpan(name, { attributes }, sessionContext);
			sessionContext = api.trace.setSpan(sessionContext, span);

			try {
				const result = fn(span);
				span.setStatus({ code: 1 as SpanStatusCode }); // OK
				return result;
			} catch (error) {
				span.setStatus({
					code: 2 as SpanStatusCode, // ERROR
					message: error instanceof Error ? error.message : String(error),
				});
				if (error instanceof Error) {
					span.recordException(error);
				}
				throw error;
			} finally {
				span.end();
				sessionContext = parentContext;
			}
		},

		async withSpanAsync<T>(
			name: TallowSpanName,
			attributes: TallowSpanAttributes,
			fn: (span: Span) => Promise<T>
		): Promise<T> {
			const parentContext = sessionContext;
			const span = tracer.startSpan(name, { attributes }, sessionContext);
			sessionContext = api.trace.setSpan(sessionContext, span);

			try {
				const result = await fn(span);
				span.setStatus({ code: 1 as SpanStatusCode }); // OK
				return result;
			} catch (error) {
				span.setStatus({
					code: 2 as SpanStatusCode, // ERROR
					message: error instanceof Error ? error.message : String(error),
				});
				if (error instanceof Error) {
					span.recordException(error);
				}
				throw error;
			} finally {
				span.end();
				sessionContext = parentContext;
			}
		},

		getTraceContext(): TraceContextCarrier | null {
			const activeSpan = api.trace.getSpan(sessionContext);
			if (!activeSpan) return null;

			const { traceId, spanId, traceFlags } = activeSpan.spanContext();
			if (!traceId || traceId === "") return null;

			const traceparent = `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, "0")}`;
			return { traceparent };
		},

		getActiveContext(): Context | undefined {
			return sessionContext;
		},

		getTracerProvider(): TracerProvider | undefined {
			return provider;
		},
	};
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a session-scoped telemetry handle.
 *
 * Returns a no-op handle when `config` is undefined (telemetry disabled).
 * When `config` is provided, dynamically imports `@opentelemetry/api` and
 * creates a live handle backed by the given tracer provider.
 *
 * @param config - Optional telemetry configuration from session options
 * @param version - Tallow version string for tracer scope metadata
 * @param incomingCarrier - Optional incoming trace context from env/CLI
 * @returns Session-scoped telemetry handle
 */
export async function createTelemetryHandle(
	config: TallowTelemetryConfig | undefined,
	version: string,
	incomingCarrier?: TraceContextCarrier | null
): Promise<TelemetryHandle> {
	if (!config) {
		return NOOP_HANDLE;
	}

	// Dynamic import so the module is never loaded when telemetry is off.
	const api = await import("@opentelemetry/api");

	const tracer = config.tracerProvider.getTracer(
		config.serviceName ?? TRACER_SCOPE,
		config.serviceVersion ?? version
	);

	// If there's an incoming trace context from env, extract it.
	let incomingContext: Context | undefined;
	if (incomingCarrier) {
		const propagator = api.propagation;
		const carrier: Record<string, string> = { traceparent: incomingCarrier.traceparent };
		if (incomingCarrier.tracestate) {
			carrier.tracestate = incomingCarrier.tracestate;
		}
		incomingContext = propagator.extract(api.ROOT_CONTEXT, carrier);
	}

	return createLiveHandle(tracer, api, config.tracerProvider, incomingContext);
}

// ─── Safe Attribute Builders ─────────────────────────────────────────────────

/**
 * Build safe session attributes — metadata only, no secrets.
 *
 * @param sessionId - Session identifier
 * @param cwd - Working directory (hashed, not raw path)
 * @returns Safe span attributes
 */
export function sessionAttributes(sessionId: string, cwd: string): TallowSpanAttributes {
	return {
		"tallow.session.id": sessionId,
		"tallow.session.cwd_hash": hashString(cwd),
	};
}

/**
 * Build safe prompt/turn attributes.
 *
 * @param turnIndex - Current turn number
 * @returns Safe span attributes
 */
export function promptAttributes(turnIndex: number): TallowSpanAttributes {
	return {
		"tallow.prompt.turn_index": turnIndex,
	};
}

/**
 * Build safe model call attributes.
 *
 * @param provider - Model provider identifier
 * @param modelId - Model identifier
 * @param retryCount - Number of retries attempted
 * @returns Safe span attributes
 */
export function modelAttributes(
	provider: string,
	modelId: string,
	retryCount?: number
): TallowSpanAttributes {
	const attrs: TallowSpanAttributes = {
		"tallow.model.provider": provider,
		"tallow.model.id": modelId,
	};
	if (retryCount !== undefined) {
		return { ...attrs, "tallow.model.retry_count": retryCount };
	}
	return attrs;
}

/**
 * Build safe tool call attributes — tool name only, no payloads.
 *
 * @param toolName - Name of the tool being called
 * @param toolCallId - Unique tool call identifier
 * @returns Safe span attributes
 */
export function toolAttributes(toolName: string, toolCallId?: string): TallowSpanAttributes {
	const attrs: TallowSpanAttributes = {
		"tallow.tool.name": toolName,
	};
	if (toolCallId) {
		return { ...attrs, "tallow.tool.call_id": toolCallId };
	}
	return attrs;
}

/**
 * Build safe subagent attributes — identity only, no task content.
 *
 * @param agentId - Subagent identifier
 * @param agentType - Agent type/name
 * @param background - Whether running in background mode
 * @returns Safe span attributes
 */
export function subagentAttributes(
	agentId: string,
	agentType: string,
	background: boolean
): TallowSpanAttributes {
	return {
		"tallow.subagent.id": agentId,
		"tallow.subagent.type": agentType,
		"tallow.subagent.background": background,
	};
}

/**
 * Build safe teammate attributes — identity only.
 *
 * @param teamName - Team name
 * @param teammateName - Teammate name
 * @param modelId - Model used by the teammate
 * @returns Safe span attributes
 */
export function teammateAttributes(
	teamName: string,
	teammateName: string,
	modelId: string
): TallowSpanAttributes {
	return {
		"tallow.teammate.team": teamName,
		"tallow.teammate.name": teammateName,
		"tallow.teammate.model": modelId,
	};
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Simple non-cryptographic hash for path anonymization.
 *
 * @param input - String to hash
 * @returns 8-char hex hash
 */
function hashString(input: string): string {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		const char = input.charCodeAt(i);
		hash = ((hash << 5) - hash + char) | 0;
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

// ─── Event Channel ───────────────────────────────────────────────────────────

/**
 * Event channels for telemetry handle sharing across extensions.
 *
 * Extensions that need access to the telemetry handle (subagent, teams)
 * can request it via the event bus handshake pattern.
 */
export const TELEMETRY_API_CHANNELS = {
	/** Channel on which the telemetry handle is published. */
	api: "interop.api.v1.telemetry.api",
	/** Channel on which extensions request the telemetry handle. */
	apiRequest: "interop.api.v1.telemetry.api-request",
} as const;
