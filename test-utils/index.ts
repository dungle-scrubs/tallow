/**
 * Test utilities for tallow integration and e2e testing.
 *
 * @module test-utils
 */

export type {
	AppendedEntry,
	RegisteredFlag,
	RegisteredProvider,
	RegisteredShortcut,
	SentMessage,
	SentUserMessage,
} from "./extension-harness.js";
// Extension testing
export { ExtensionHarness } from "./extension-harness.js";
export { FakeChildProcess } from "./fake-child-process.js";
export type { ScriptedResponse, TextResponse, ToolCallResponse } from "./mock-model.js";
// Mock model and stream functions
export {
	createEchoStreamFn,
	createMockModel,
	createScriptedStreamFn,
} from "./mock-model.js";
export type { MockScope } from "./mock-scope.js";
export { createMockScope } from "./mock-scope.js";
export type { RunResult, SessionRunnerOptions } from "./session-runner.js";
// Session runner
export { createSessionRunner, SessionRunner } from "./session-runner.js";
export type { Renderable } from "./virtual-terminal.js";
// Virtual terminal
export { renderComponent, renderSnapshot, stripAnsi } from "./virtual-terminal.js";
