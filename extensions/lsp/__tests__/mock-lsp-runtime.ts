import { mock } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as realChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

interface SymbolCapabilitySet {
	definitionProvider: boolean;
	documentSymbolProvider: boolean;
	hoverProvider: boolean;
	referencesProvider: boolean;
	workspaceSymbolProvider: boolean;
}

interface LspMockBehavior {
	definition: (params: unknown) => Promise<unknown>;
	documentSymbol: (params: unknown) => Promise<unknown>;
	hover: (params: unknown) => Promise<unknown>;
	initialize: (params: unknown) => Promise<{ capabilities: SymbolCapabilitySet }>;
	references: (params: unknown) => Promise<unknown>;
	shutdown: (params: unknown) => Promise<void>;
	which: (command: string) => Promise<number>;
	workspaceSymbol: (params: unknown) => Promise<unknown>;
}

interface SpawnedProcessRecord {
	args: string[];
	command: string;
	killed: boolean;
}

/** Commands mocked as language-server subprocesses. */
const MOCKED_SERVER_COMMANDS = new Set([
	"typescript-language-server",
	"ty",
	"pyright-langserver",
	"rust-analyzer",
	"sourcekit-lsp",
	"intelephense",
]);

export interface LspMockRuntime {
	readonly behavior: LspMockBehavior;
	readonly exitNotifications: { params: unknown }[];
	readonly initializedNotifications: { params: unknown }[];
	readonly shutdownRequests: { params: unknown }[];
	readonly spawnedServers: SpawnedProcessRecord[];
	readonly spawn: typeof realChildProcess.spawn;
	reset: () => void;
}

interface ProtocolRequestTypes {
	DidOpenTextDocumentNotification: { type: symbol };
	DocumentSymbolRequest: { type: symbol };
	ExitNotification: { type: symbol };
	HoverRequest: { type: symbol };
	InitializedNotification: { type: symbol };
	InitializeRequest: { type: symbol };
	ReferencesRequest: { type: symbol };
	ShutdownRequest: { type: symbol };
	WorkspaceSymbolRequest: { type: symbol };
	DefinitionRequest: { type: symbol };
}

const GLOBAL_KEY = "__tallow_lsp_mock_runtime__";

/**
 * Creates the default capability object returned by InitializeRequest.
 *
 * @returns Fully enabled symbol capability set
 */
function createDefaultCapabilities(): SymbolCapabilitySet {
	return {
		definitionProvider: true,
		documentSymbolProvider: true,
		hoverProvider: true,
		referencesProvider: true,
		workspaceSymbolProvider: true,
	};
}

/**
 * Creates default behavior handlers for the mocked protocol connection.
 *
 * @returns Default behavior object used in tests
 */
function createDefaultBehavior(): LspMockBehavior {
	return {
		definition: async () => null,
		documentSymbol: async () => [],
		hover: async () => ({ contents: "hover" }),
		initialize: async () => ({ capabilities: createDefaultCapabilities() }),
		references: async () => [],
		shutdown: async () => {},
		which: async () => 0,
		workspaceSymbol: async () => [],
	};
}

/**
 * Creates and registers runtime module mocks for LSP tests.
 *
 * Always pair with {@link teardownLspMockRuntime} in suite teardown so
 * LSP protocol mocks cannot leak into other suites.
 *
 * @returns Shared runtime state and behavior controls
 */
export function setupLspMockRuntime(): LspMockRuntime {
	const globalState = globalThis as Record<string, unknown>;
	const existing = globalState[GLOBAL_KEY] as LspMockRuntime | undefined;
	if (existing) {
		return existing;
	}

	const behavior = createDefaultBehavior();
	const spawnedServers: SpawnedProcessRecord[] = [];
	const shutdownRequests: { params: unknown }[] = [];
	const initializedNotifications: { params: unknown }[] = [];
	const exitNotifications: { params: unknown }[] = [];

	const requestTypes: ProtocolRequestTypes = {
		DefinitionRequest: { type: Symbol("DefinitionRequest") },
		DidOpenTextDocumentNotification: { type: Symbol("DidOpenTextDocumentNotification") },
		DocumentSymbolRequest: { type: Symbol("DocumentSymbolRequest") },
		ExitNotification: { type: Symbol("ExitNotification") },
		HoverRequest: { type: Symbol("HoverRequest") },
		InitializedNotification: { type: Symbol("InitializedNotification") },
		InitializeRequest: { type: Symbol("InitializeRequest") },
		ReferencesRequest: { type: Symbol("ReferencesRequest") },
		ShutdownRequest: { type: Symbol("ShutdownRequest") },
		WorkspaceSymbolRequest: { type: Symbol("WorkspaceSymbolRequest") },
	};

	class FakeChildProcess extends EventEmitter {
		readonly stderr = new PassThrough();
		readonly stdin = new PassThrough();
		readonly stdout = new PassThrough();

		private killed = false;

		constructor(private readonly record?: SpawnedProcessRecord) {
			super();
		}

		kill(): boolean {
			if (this.killed) {
				return true;
			}
			this.killed = true;
			if (this.record) {
				this.record.killed = true;
			}
			this.emit("exit", null);
			this.emit("close", 0);
			return true;
		}

		ref(): this {
			return this;
		}

		unref(): this {
			return this;
		}
	}

	const spawn = ((command: string, ...spawnArgs: unknown[]): ChildProcess => {
		const firstArg = spawnArgs[0];
		const argv = Array.isArray(firstArg) ? [...(firstArg as string[])] : [];

		if (command === "which") {
			const proc = new FakeChildProcess();
			void behavior
				.which(argv[0] ?? "")
				.then((code) => {
					proc.emit("close", code);
				})
				.catch((error) => {
					proc.emit("error", error);
				});
			return proc as unknown as ChildProcess;
		}

		if (!MOCKED_SERVER_COMMANDS.has(command)) {
			return (realChildProcess.spawn as (...args: unknown[]) => ChildProcess)(
				command,
				...(spawnArgs as unknown[])
			);
		}

		const record: SpawnedProcessRecord = {
			args: argv,
			command,
			killed: false,
		};
		spawnedServers.push(record);
		return new FakeChildProcess(record) as unknown as ChildProcess;
	}) as typeof realChildProcess.spawn;

	mock.module("vscode-jsonrpc/node", () => ({
		StreamMessageReader: class StreamMessageReader {},
		StreamMessageWriter: class StreamMessageWriter {},
	}));

	mock.module("vscode-languageserver-protocol", () => ({
		createProtocolConnection() {
			return {
				dispose() {},
				listen() {},
				sendNotification(type: unknown, params: unknown) {
					if (type === requestTypes.InitializedNotification.type) {
						initializedNotifications.push({ params });
					}
					if (type === requestTypes.ExitNotification.type) {
						exitNotifications.push({ params });
					}
				},
				async sendRequest(type: unknown, params: unknown) {
					if (type === requestTypes.InitializeRequest.type) {
						return behavior.initialize(params);
					}
					if (type === requestTypes.DefinitionRequest.type) {
						return behavior.definition(params);
					}
					if (type === requestTypes.ReferencesRequest.type) {
						return behavior.references(params);
					}
					if (type === requestTypes.HoverRequest.type) {
						return behavior.hover(params);
					}
					if (type === requestTypes.DocumentSymbolRequest.type) {
						return behavior.documentSymbol(params);
					}
					if (type === requestTypes.WorkspaceSymbolRequest.type) {
						return behavior.workspaceSymbol(params);
					}
					if (type === requestTypes.ShutdownRequest.type) {
						shutdownRequests.push({ params });
						await behavior.shutdown(params);
						return null;
					}
					return null;
				},
			};
		},
		DefinitionRequest: requestTypes.DefinitionRequest,
		DidOpenTextDocumentNotification: requestTypes.DidOpenTextDocumentNotification,
		DocumentSymbolRequest: requestTypes.DocumentSymbolRequest,
		ExitNotification: requestTypes.ExitNotification,
		HoverRequest: requestTypes.HoverRequest,
		InitializedNotification: requestTypes.InitializedNotification,
		InitializeRequest: requestTypes.InitializeRequest,
		ReferencesRequest: requestTypes.ReferencesRequest,
		ShutdownRequest: requestTypes.ShutdownRequest,
		WorkspaceSymbolRequest: requestTypes.WorkspaceSymbolRequest,
	}));

	const runtime: LspMockRuntime = {
		behavior,
		exitNotifications,
		initializedNotifications,
		reset() {
			Object.assign(behavior, createDefaultBehavior());
			exitNotifications.length = 0;
			initializedNotifications.length = 0;
			shutdownRequests.length = 0;
			spawnedServers.length = 0;
		},
		shutdownRequests,
		spawn,
		spawnedServers,
	};

	globalState[GLOBAL_KEY] = runtime;
	return runtime;
}

/**
 * Restores all Bun module mocks and clears the shared LSP runtime state.
 *
 * @returns Nothing
 */
export function teardownLspMockRuntime(): void {
	const globalState = globalThis as Record<string, unknown>;
	delete globalState[GLOBAL_KEY];
	mock.restore();
	mock.clearAllMocks();
}
