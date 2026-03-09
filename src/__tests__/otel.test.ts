/**
 * Tests for the OTEL integration layer.
 *
 * Covers no-op behavior, safe attribute builders, env propagation helpers,
 * and privacy/redaction guarantees.
 */

import { describe, expect, test } from "bun:test";
import {
	createTelemetryHandle,
	extractTraceContextFromEnv,
	injectTraceContextToEnv,
	modelAttributes,
	promptAttributes,
	sessionAttributes,
	subagentAttributes,
	type TallowTelemetryConfig,
	type TelemetryHandle,
	teammateAttributes,
	toolAttributes,
} from "../otel.js";

// ─── No-op Behavior ─────────────────────────────────────────────────────────

describe("no-op telemetry", () => {
	test("returns disabled handle when config is undefined", async () => {
		const handle = await createTelemetryHandle(undefined, "0.1.0");
		expect(handle.enabled).toBe(false);
	});

	test("startSpan returns a non-recording stub span", async () => {
		const handle = await createTelemetryHandle(undefined, "0.1.0");
		const span = handle.startSpan("tallow.session.create");
		expect(span.isRecording()).toBe(false);
		expect(span.spanContext().traceId).toBe("");
		// Should not throw
		span.setAttribute("key", "value");
		span.end();
	});

	test("withSpan executes the function and returns its result", async () => {
		const handle = await createTelemetryHandle(undefined, "0.1.0");
		const result = handle.withSpan("tallow.tool.call", {}, (span) => {
			expect(span.isRecording()).toBe(false);
			return 42;
		});
		expect(result).toBe(42);
	});

	test("withSpanAsync executes the async function and returns its result", async () => {
		const handle = await createTelemetryHandle(undefined, "0.1.0");
		const result = await handle.withSpanAsync("tallow.model.call", {}, async (span) => {
			expect(span.isRecording()).toBe(false);
			return "async-result";
		});
		expect(result).toBe("async-result");
	});

	test("getTraceContext returns null when disabled", async () => {
		const handle = await createTelemetryHandle(undefined, "0.1.0");
		expect(handle.getTraceContext()).toBeNull();
	});

	test("getActiveContext returns undefined when disabled", async () => {
		const handle = await createTelemetryHandle(undefined, "0.1.0");
		expect(handle.getActiveContext()).toBeUndefined();
	});

	test("getTracerProvider returns undefined when disabled", async () => {
		const handle = await createTelemetryHandle(undefined, "0.1.0");
		expect(handle.getTracerProvider()).toBeUndefined();
	});
});

// ─── Safe Attribute Builders ─────────────────────────────────────────────────

describe("safe attribute builders", () => {
	test("sessionAttributes hashes cwd and includes session id", () => {
		const attrs = sessionAttributes("test-session-id", "/some/path");
		expect(attrs["tallow.session.id"]).toBe("test-session-id");
		expect(typeof attrs["tallow.session.cwd_hash"]).toBe("string");
		// CWD should be hashed, not the raw path
		expect(attrs["tallow.session.cwd_hash"]).not.toBe("/some/path");
		expect((attrs["tallow.session.cwd_hash"] as string).length).toBe(8);
	});

	test("sessionAttributes produces different hashes for different paths", () => {
		const a = sessionAttributes("s1", "/path/a");
		const b = sessionAttributes("s1", "/path/b");
		expect(a["tallow.session.cwd_hash"]).not.toBe(b["tallow.session.cwd_hash"]);
	});

	test("promptAttributes includes turn index", () => {
		const attrs = promptAttributes(5);
		expect(attrs["tallow.prompt.turn_index"]).toBe(5);
	});

	test("modelAttributes includes provider and model id", () => {
		const attrs = modelAttributes("anthropic", "claude-sonnet-4");
		expect(attrs["tallow.model.provider"]).toBe("anthropic");
		expect(attrs["tallow.model.id"]).toBe("claude-sonnet-4");
		expect(attrs["tallow.model.retry_count"]).toBeUndefined();
	});

	test("modelAttributes includes retry count when provided", () => {
		const attrs = modelAttributes("openai", "gpt-4o", 2);
		expect(attrs["tallow.model.retry_count"]).toBe(2);
	});

	test("toolAttributes includes tool name only", () => {
		const attrs = toolAttributes("bash");
		expect(attrs["tallow.tool.name"]).toBe("bash");
		expect(attrs["tallow.tool.call_id"]).toBeUndefined();
	});

	test("toolAttributes includes call id when provided", () => {
		const attrs = toolAttributes("read", "call-123");
		expect(attrs["tallow.tool.call_id"]).toBe("call-123");
	});

	test("subagentAttributes includes identity and mode", () => {
		const attrs = subagentAttributes("agent-1", "coder", true);
		expect(attrs["tallow.subagent.id"]).toBe("agent-1");
		expect(attrs["tallow.subagent.type"]).toBe("coder");
		expect(attrs["tallow.subagent.background"]).toBe(true);
	});

	test("teammateAttributes includes team and teammate identity", () => {
		const attrs = teammateAttributes("backend-team", "alice", "claude-sonnet-4");
		expect(attrs["tallow.teammate.team"]).toBe("backend-team");
		expect(attrs["tallow.teammate.name"]).toBe("alice");
		expect(attrs["tallow.teammate.model"]).toBe("claude-sonnet-4");
	});
});

// ─── Privacy / Redaction ─────────────────────────────────────────────────────

describe("privacy guarantees", () => {
	test("sessionAttributes does not expose raw cwd path", () => {
		const secretPath = "/Users/kevin/dev/secret-project";
		const attrs = sessionAttributes("s", secretPath);
		const values = Object.values(attrs).map(String);
		expect(values).not.toContain(secretPath);
	});

	test("toolAttributes does not include any payload fields", () => {
		const attrs = toolAttributes("read", "call-1");
		const keys = Object.keys(attrs);
		expect(keys).not.toContain("tallow.tool.input");
		expect(keys).not.toContain("tallow.tool.output");
		expect(keys).not.toContain("tallow.tool.content");
	});

	test("modelAttributes does not include prompt text", () => {
		const attrs = modelAttributes("anthropic", "claude-sonnet-4", 0);
		const keys = Object.keys(attrs);
		expect(keys).not.toContain("tallow.model.prompt");
		expect(keys).not.toContain("tallow.model.response");
	});
});

// ─── Env Propagation ─────────────────────────────────────────────────────────

describe("trace context env propagation", () => {
	test("extractTraceContextFromEnv returns null when no traceparent", () => {
		const result = extractTraceContextFromEnv({});
		expect(result).toBeNull();
	});

	test("extractTraceContextFromEnv returns null for invalid traceparent", () => {
		const result = extractTraceContextFromEnv({ TRACEPARENT: "invalid" });
		expect(result).toBeNull();
	});

	test("extractTraceContextFromEnv parses valid traceparent", () => {
		const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
		const result = extractTraceContextFromEnv({ TRACEPARENT: tp });
		expect(result).not.toBeNull();
		expect(result!.traceparent).toBe(tp);
		expect(result!.tracestate).toBeUndefined();
	});

	test("extractTraceContextFromEnv includes tracestate when present", () => {
		const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
		const result = extractTraceContextFromEnv({
			TRACEPARENT: tp,
			TRACESTATE: "congo=t61rcWkgMzE",
		});
		expect(result!.tracestate).toBe("congo=t61rcWkgMzE");
	});

	test("extractTraceContextFromEnv handles lowercase env vars", () => {
		const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
		const result = extractTraceContextFromEnv({ traceparent: tp });
		expect(result!.traceparent).toBe(tp);
	});

	test("injectTraceContextToEnv writes TRACEPARENT", () => {
		const env: Record<string, string> = {};
		injectTraceContextToEnv(
			{ traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
			env
		);
		expect(env.TRACEPARENT).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
		expect(env.TRACESTATE).toBeUndefined();
	});

	test("injectTraceContextToEnv writes TRACESTATE when present", () => {
		const env: Record<string, string> = {};
		injectTraceContextToEnv(
			{
				traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
				tracestate: "foo=bar",
			},
			env
		);
		expect(env.TRACEPARENT).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
		expect(env.TRACESTATE).toBe("foo=bar");
	});

	test("round-trip: inject then extract preserves trace context", () => {
		const original = {
			traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
			tracestate: "congo=t61rcWkgMzE",
		};
		const env: Record<string, string> = {};
		injectTraceContextToEnv(original, env);
		const extracted = extractTraceContextFromEnv(env);
		expect(extracted).toEqual(original);
	});
});

// ─── Live Telemetry Handle ───────────────────────────────────────────────────

describe("live telemetry handle", () => {
	/**
	 * Create a minimal in-memory tracer provider for testing.
	 * Records span names and attributes for assertion.
	 */
	function createTestTracerProvider() {
		const spans: Array<{ name: string; attributes: Record<string, unknown>; ended: boolean }> = [];

		const provider: TallowTelemetryConfig["tracerProvider"] = {
			getTracer(_name: string, _version?: string) {
				return {
					startSpan(
						name: string,
						options?: { attributes?: Record<string, unknown> },
						_context?: unknown
					) {
						const record = {
							name,
							attributes: { ...(options?.attributes ?? {}) },
							ended: false,
						};
						spans.push(record);

						return {
							spanContext: () => ({
								traceId: "0af7651916cd43dd8448eb211c80319c",
								spanId: "b7ad6b7169203331",
								traceFlags: 1,
							}),
							setAttribute(key: string, value: unknown) {
								record.attributes[key] = value;
								return this;
							},
							setAttributes(attrs: Record<string, unknown>) {
								Object.assign(record.attributes, attrs);
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
							setStatus(status: { code: number; message?: string }) {
								record.attributes["__status_code"] = status.code;
								if (status.message) record.attributes["__status_message"] = status.message;
								return this;
							},
							updateName(n: string) {
								record.name = n;
								return this;
							},
							end() {
								record.ended = true;
							},
							isRecording() {
								return true;
							},
							recordException(err: Error) {
								record.attributes["__exception"] = err.message;
							},
						};
					},
					startActiveSpan: (() => {}) as never,
				};
			},
		};

		return { provider, spans };
	}

	test("creates enabled handle with tracer provider", async () => {
		const { provider } = createTestTracerProvider();
		const handle = await createTelemetryHandle({ tracerProvider: provider }, "1.0.0");
		expect(handle.enabled).toBe(true);
	});

	test("startSpan creates a recording span", async () => {
		const { provider, spans } = createTestTracerProvider();
		const handle = await createTelemetryHandle({ tracerProvider: provider }, "1.0.0");

		const span = handle.startSpan("tallow.session.create", { "tallow.session.id": "test-123" });
		expect(span.isRecording()).toBe(true);
		expect(spans).toHaveLength(1);
		expect(spans[0].name).toBe("tallow.session.create");
		expect(spans[0].attributes["tallow.session.id"]).toBe("test-123");

		span.end();
		expect(spans[0].ended).toBe(true);
	});

	test("withSpan ends span on success", async () => {
		const { provider, spans } = createTestTracerProvider();
		const handle = await createTelemetryHandle({ tracerProvider: provider }, "1.0.0");

		const result = handle.withSpan("tallow.tool.call", { "tallow.tool.name": "bash" }, () => {
			return "done";
		});

		expect(result).toBe("done");
		expect(spans).toHaveLength(1);
		expect(spans[0].ended).toBe(true);
		expect(spans[0].attributes["__status_code"]).toBe(1); // OK
	});

	test("withSpan records error and re-throws on failure", async () => {
		const { provider, spans } = createTestTracerProvider();
		const handle = await createTelemetryHandle({ tracerProvider: provider }, "1.0.0");

		expect(() => {
			handle.withSpan("tallow.tool.call", {}, () => {
				throw new Error("test error");
			});
		}).toThrow("test error");

		expect(spans[0].ended).toBe(true);
		expect(spans[0].attributes["__status_code"]).toBe(2); // ERROR
		expect(spans[0].attributes["__status_message"]).toBe("test error");
		expect(spans[0].attributes["__exception"]).toBe("test error");
	});

	test("withSpanAsync ends span on success", async () => {
		const { provider, spans } = createTestTracerProvider();
		const handle = await createTelemetryHandle({ tracerProvider: provider }, "1.0.0");

		const result = await handle.withSpanAsync(
			"tallow.model.call",
			{ "tallow.model.provider": "anthropic" },
			async () => {
				return "model-result";
			}
		);

		expect(result).toBe("model-result");
		expect(spans[0].ended).toBe(true);
		expect(spans[0].attributes["__status_code"]).toBe(1);
	});

	test("withSpanAsync records error and re-throws on failure", async () => {
		const { provider, spans } = createTestTracerProvider();
		const handle = await createTelemetryHandle({ tracerProvider: provider }, "1.0.0");

		await expect(
			handle.withSpanAsync("tallow.model.call", {}, async () => {
				throw new Error("async error");
			})
		).rejects.toThrow("async error");

		expect(spans[0].ended).toBe(true);
		expect(spans[0].attributes["__status_code"]).toBe(2);
	});

	test("getTracerProvider returns the configured provider", async () => {
		const { provider } = createTestTracerProvider();
		const handle = await createTelemetryHandle({ tracerProvider: provider }, "1.0.0");
		expect(handle.getTracerProvider()).toBe(provider);
	});

	test("getTraceContext returns a valid traceparent", async () => {
		const { provider } = createTestTracerProvider();
		const handle = await createTelemetryHandle({ tracerProvider: provider }, "1.0.0");

		// Start a span so there's an active context
		const span = handle.startSpan("tallow.session.create");
		const carrier = handle.getTraceContext();
		expect(carrier).not.toBeNull();
		expect(carrier!.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);

		span.end();
	});

	test("uses custom service name and version", async () => {
		const { provider } = createTestTracerProvider();
		const handle = await createTelemetryHandle(
			{
				tracerProvider: provider,
				serviceName: "marrow-gateway",
				serviceVersion: "2.0.0",
			},
			"1.0.0"
		);
		expect(handle.enabled).toBe(true);
		// Service name/version are passed to getTracer, which our mock accepts silently
	});
});
