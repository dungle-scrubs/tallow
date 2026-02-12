/**
 * Mock model and stream function for headless session testing.
 *
 * Provides a fake LLM model and scriptable stream function that produces
 * correct event sequences without making any API calls.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
	Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

// ── Types ────────────────────────────────────────────────────────────────────

/** A scripted text response. */
export interface TextResponse {
	text: string;
}

/** A scripted tool call response. */
export interface ToolCallResponse {
	toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
}

/** A single scripted response (text or tool calls). */
export type ScriptedResponse = TextResponse | ToolCallResponse;

// ── Mock Model ───────────────────────────────────────────────────────────────

/** Zero-cost usage for mock responses. */
const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Create a mock Model object suitable for session creation.
 *
 * @param overrides - Optional field overrides
 * @returns A valid Model object with zero costs and mock provider
 */
export function createMockModel(overrides?: Partial<Model<Api>>): Model<Api> {
	return {
		id: "mock-model",
		name: "Mock Model",
		api: "anthropic-messages" as Api,
		provider: "mock",
		baseUrl: "http://localhost:0",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		...overrides,
	};
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a partial AssistantMessage used in streaming events. */
function buildPartial(
	model: Model<Api>,
	content: AssistantMessage["content"] = []
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...ZERO_USAGE },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

let _toolCallCounter = 0;

/**
 * Emit a text response into an event stream.
 *
 * @param stream - Target event stream
 * @param text - Text content to emit
 * @param model - Model for message metadata
 */
function emitTextResponse(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	text: string,
	model: Model<Api>
): void {
	const textContent: TextContent = { type: "text", text };
	const partial = buildPartial(model, [textContent]);
	stream.push({ type: "start", partial: buildPartial(model) });
	stream.push({ type: "text_start", contentIndex: 0, partial: buildPartial(model) });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
	const message: AssistantMessage = { ...partial, stopReason: "stop" };
	stream.push({ type: "done", reason: "stop", message });
}

/**
 * Emit tool call responses into an event stream.
 *
 * @param stream - Target event stream
 * @param toolCalls - Tool calls to emit
 * @param model - Model for message metadata
 */
function emitToolCallResponse(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	toolCalls: ToolCallResponse["toolCalls"],
	model: Model<Api>
): void {
	const content: ToolCall[] = toolCalls.map((tc, _i) => ({
		type: "toolCall" as const,
		id: `mock-tc-${++_toolCallCounter}`,
		name: tc.name,
		arguments: tc.arguments,
	}));
	const partial = buildPartial(model, content);
	stream.push({ type: "start", partial: buildPartial(model) });

	for (let i = 0; i < content.length; i++) {
		const tc = content[i];
		const argsJson = JSON.stringify(tc.arguments);
		stream.push({
			type: "toolcall_start",
			contentIndex: i,
			partial: buildPartial(model, content.slice(0, i)),
		});
		stream.push({
			type: "toolcall_delta",
			contentIndex: i,
			delta: argsJson,
			partial: buildPartial(model, content.slice(0, i + 1)),
		});
		stream.push({
			type: "toolcall_end",
			contentIndex: i,
			toolCall: tc,
			partial: buildPartial(model, content.slice(0, i + 1)),
		});
	}

	const message: AssistantMessage = { ...partial, stopReason: "toolUse" };
	stream.push({ type: "done", reason: "toolUse", message });
}

/**
 * Type guard: is this a tool call response?
 *
 * @param r - Scripted response
 * @returns True if response contains tool calls
 */
function isToolCallResponse(r: ScriptedResponse): r is ToolCallResponse {
	return "toolCalls" in r;
}

// ── Mock Stream Function ─────────────────────────────────────────────────────

/**
 * Create a scripted stream function that returns predetermined responses.
 *
 * Responses are consumed in order. After all responses are exhausted,
 * subsequent calls return a fallback "No more responses" text.
 *
 * @param responses - Ordered list of scripted responses
 * @returns StreamFn compatible with Agent
 */
export function createScriptedStreamFn(responses: ScriptedResponse[]): StreamFn {
	const queue = [...responses];
	return (model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
		const stream = createAssistantMessageEventStream();
		const response = queue.shift();

		// Emit async to allow consumer to set up iterator first
		queueMicrotask(() => {
			if (!response) {
				emitTextResponse(stream, "[MockModel: no more scripted responses]", model);
			} else if (isToolCallResponse(response)) {
				emitToolCallResponse(stream, response.toolCalls, model);
			} else {
				emitTextResponse(stream, response.text, model);
			}
		});

		return stream;
	};
}

/**
 * Create an echo stream function that repeats back the last user message.
 *
 * @returns StreamFn that echoes user input
 */
export function createEchoStreamFn(): StreamFn {
	return (model: Model<Api>, context: Context) => {
		const stream = createAssistantMessageEventStream();
		const lastUserMsg = [...context.messages].reverse().find((m) => m.role === "user");
		const echoText = lastUserMsg
			? typeof lastUserMsg.content === "string"
				? lastUserMsg.content
				: lastUserMsg.content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("")
			: "[echo: no user message found]";

		queueMicrotask(() => emitTextResponse(stream, echoText, model));
		return stream;
	};
}
