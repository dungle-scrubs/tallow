import type { ChildProcess } from "node:child_process";
import * as realChildProcess from "node:child_process";
import { FakeChildProcess } from "../../../test-utils/fake-child-process.js";

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

interface ProtocolMockBindings extends ProtocolRequestTypes {
	createProtocolConnection: () => {
		dispose: () => void;
		listen: () => void;
		sendNotification: (type: unknown, params: unknown) => void;
		sendRequest: (type: unknown, params: unknown) => Promise<unknown>;
	};
}

export interface LspMockRuntime {
	readonly behavior: LspMockBehavior;
	readonly exitNotifications: { params: unknown }[];
	readonly initializedNotifications: { params: unknown }[];
	readonly protocol: ProtocolMockBindings;
	readonly shutdownRequests: { params: unknown }[];
	readonly spawn: typeof realChildProcess.spawn;
	readonly spawnedServers: SpawnedProcessRecord[];
	reset: () => void;
}

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
 * Creates deterministic runtime controls for LSP extension tests.
 *
 * @returns Shared runtime state and behavior controls
 */
export function setupLspMockRuntime(): LspMockRuntime {
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

	const protocol: ProtocolMockBindings = {
		...requestTypes,
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
	};

	const spawn = ((command: string, ...spawnArgs: unknown[]): ChildProcess => {
		const firstArg = spawnArgs[0];
		const argv = Array.isArray(firstArg) ? [...(firstArg as string[])] : [];

		if (command === "which") {
			const proc = new FakeChildProcess();
			void behavior
				.which(argv[0] ?? "")
				.then((code) => {
					proc.emitClose(code);
				})
				.catch((error) => {
					proc.emitError(error);
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
		return new FakeChildProcess({
			onKill() {
				record.killed = true;
			},
		}) as unknown as ChildProcess;
	}) as typeof realChildProcess.spawn;

	return {
		behavior,
		exitNotifications,
		initializedNotifications,
		protocol,
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
}

/**
 * Compatibility teardown hook for suites using setupLspMockRuntime.
 *
 * @returns Nothing
 */
export function teardownLspMockRuntime(): void {}
