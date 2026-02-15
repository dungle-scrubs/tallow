/**
 * LSP Extension for Pi
 * Provides code intelligence via Language Server Protocol
 *
 * Capabilities:
 * - Go to definition
 * - Find references
 * - Hover (type info)
 * - Document symbols
 * - Workspace symbols
 * - Diagnostics (auto-reported after edits)
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import {
	createProtocolConnection,
	DefinitionRequest,
	DidOpenTextDocumentNotification,
	type DocumentSymbol,
	DocumentSymbolRequest,
	ExitNotification,
	type Hover,
	HoverRequest,
	InitializedNotification,
	type InitializeParams,
	InitializeRequest,
	type Location,
	type LocationLink,
	type ProtocolConnection,
	ReferencesRequest,
	ShutdownRequest,
	type SymbolInformation,
	type WorkspaceSymbol,
	WorkspaceSymbolRequest,
} from "vscode-languageserver-protocol";
import { getIcon } from "../_icons/index.js";

/** Language server binary configuration and project detection markers. */
interface ServerConfig {
	command: string;
	args: string[];
	fileExtensions: string[];
	initOptions?: Record<string, unknown>;
	// Markers that indicate a project root for this language
	projectMarkers: string[];
}

const SERVER_CONFIGS: Record<string, ServerConfig> = {
	typescript: {
		command: "typescript-language-server",
		args: ["--stdio"],
		fileExtensions: [".ts", ".tsx", ".js", ".jsx"],
		projectMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
	},
	// ty: Astral's extremely fast Python type checker (10-100x faster than pyright)
	// https://github.com/astral-sh/ty
	python: {
		command: "ty",
		args: ["server"],
		fileExtensions: [".py", ".pyi"],
		projectMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", ".git"],
	},
	// Fallback: pyright (if ty not available)
	python_pyright: {
		command: "pyright-langserver",
		args: ["--stdio"],
		fileExtensions: [".py", ".pyi"],
		projectMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", ".git"],
	},
	// rust-analyzer: The official Rust language server
	rust: {
		command: "rust-analyzer",
		args: [],
		fileExtensions: [".rs"],
		projectMarkers: ["Cargo.toml", "Cargo.lock"],
	},
	// sourcekit-lsp: Apple's Swift/C/C++/Objective-C language server (comes with Xcode)
	swift: {
		command: "sourcekit-lsp",
		args: [],
		fileExtensions: [".swift"],
		projectMarkers: ["Package.swift", "*.xcodeproj", "*.xcworkspace", ".swiftpm"],
	},
	// intelephense: Fast PHP language server with rich feature set
	// https://intelephense.com/
	php: {
		command: "intelephense",
		args: ["--stdio"],
		fileExtensions: [".php"],
		projectMarkers: ["composer.json", "composer.lock", "artisan", "wp-config.php", ".git"],
	},
};

/** Active LSP connection state, keyed by "language:projectRoot". */
interface LSPConnection {
	process: ChildProcess;
	connection: ProtocolConnection;
	language: string;
	rootPath: string;
	rootUri: string;
	openDocuments: Map<string, { version: number; content: string }>;
	capabilities: {
		definitionProvider?: boolean;
		referencesProvider?: boolean;
		hoverProvider?: boolean;
		documentSymbolProvider?: boolean;
		workspaceSymbolProvider?: boolean;
	};
}

const connections = new Map<string, LSPConnection>();
/** Track languages where no server was found, to log once per language */
const failedLanguages = new Set<string>();

/**
 * Determines the language type for a file based on its extension.
 * @param filePath - Path to the file
 * @returns Language identifier or null if not supported
 */
function getLanguageForFile(filePath: string): string | null {
	const ext = path.extname(filePath).toLowerCase();
	// Check primary language configs (skip fallbacks like python_pyright)
	for (const [lang, config] of Object.entries(SERVER_CONFIGS)) {
		if (lang.includes("_")) continue; // Skip fallback configs
		if (config.fileExtensions.includes(ext)) {
			return lang;
		}
	}
	return null;
}

/**
 * Finds the project root by walking up looking for language-specific markers.
 * @param filePath - Path to start searching from
 * @param language - Language identifier for marker selection
 * @returns Project root directory or file's directory as fallback
 */
function findProjectRoot(filePath: string, language: string): string {
	const config = SERVER_CONFIGS[language];
	if (!config) {
		return path.dirname(filePath);
	}

	const markers = config.projectMarkers;
	let currentDir = path.dirname(path.resolve(filePath));
	const root = path.parse(currentDir).root;

	while (currentDir !== root) {
		for (const marker of markers) {
			const markerPath = path.join(currentDir, marker);
			if (fs.existsSync(markerPath)) {
				return currentDir;
			}
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	// Fallback to the file's directory if no project root found
	return path.dirname(path.resolve(filePath));
}

/**
 * Converts a file path to a file:// URI.
 * @param filePath - File path to convert
 * @returns File URI string
 */
function filePathToUri(filePath: string): string {
	const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
	return `file://${absolutePath}`;
}

/**
 * Converts a file:// URI to a file path.
 * @param uri - File URI to convert
 * @returns File path string
 */
function uriToFilePath(uri: string): string {
	return uri.replace("file://", "");
}

/**
 * Gets or creates an LSP connection for a file, auto-detecting project root.
 * @param language - Language identifier
 * @param filePath - File path to find project root from
 * @param onStarting - Optional callback invoked when a new server is being launched
 * @returns LSP connection or null if server unavailable
 */
async function getOrCreateConnectionForFile(
	language: string,
	filePath: string,
	onStarting?: (language: string) => void
): Promise<LSPConnection | null> {
	const absolutePath = path.resolve(filePath);
	const projectRoot = findProjectRoot(absolutePath, language);
	const key = `${language}:${projectRoot}`;

	// Only notify when actually launching a new server
	if (!connections.has(key) && onStarting) {
		onStarting(language);
	}

	return getOrCreateConnection(language, projectRoot);
}

/**
 * Gets or creates an LSP connection for a language and project root.
 * @param language - Language identifier
 * @param rootPath - Project root directory
 * @returns LSP connection or null if server unavailable
 */
async function getOrCreateConnection(
	language: string,
	rootPath: string
): Promise<LSPConnection | null> {
	const key = `${language}:${rootPath}`;

	const existing = connections.get(key);
	if (existing) {
		return existing;
	}

	// Try primary config first, then fallback
	const configsToTry = [language];
	if (language === "python") {
		configsToTry.push("python_pyright"); // Fallback to pyright if ty not available
	}

	let config: ServerConfig | null = null;
	let actualLanguage = language;

	for (const lang of configsToTry) {
		const c = SERVER_CONFIGS[lang];
		if (!c) continue;

		// Check if server is available
		try {
			const which = spawn("which", [c.command]);
			await new Promise<void>((resolve, reject) => {
				which.on("close", (code) => (code === 0 ? resolve() : reject()));
				which.on("error", reject);
			});
			config = c;
			actualLanguage = lang;
			break;
		} catch {}
	}

	if (!config) {
		if (!failedLanguages.has(language)) {
			failedLanguages.add(language);
			const candidates = [language, ...(language === "python" ? ["python_pyright"] : [])]
				.map((l) => SERVER_CONFIGS[l]?.command)
				.filter(Boolean);
			console.error(`LSP: no server found for ${language} (tried: ${candidates.join(", ")})`);
		}
		return null;
	}

	// Spawn the language server
	const serverProcess = spawn(config.command, config.args, {
		cwd: rootPath,
		stdio: ["pipe", "pipe", "pipe"],
	});

	if (!(serverProcess.stdout && serverProcess.stdin)) {
		serverProcess.kill();
		return null;
	}

	// Create JSON-RPC connection
	const connection = createProtocolConnection(
		new StreamMessageReader(serverProcess.stdout),
		new StreamMessageWriter(serverProcess.stdin)
	);

	connection.listen();

	// Initialize the server
	const initParams: InitializeParams = {
		processId: process.pid,
		rootUri: filePathToUri(rootPath),
		capabilities: {
			textDocument: {
				synchronization: {
					dynamicRegistration: false,
					willSave: false,
					willSaveWaitUntil: false,
					didSave: true,
				},
				completion: { dynamicRegistration: false },
				hover: { dynamicRegistration: false },
				definition: { dynamicRegistration: false },
				references: { dynamicRegistration: false },
				documentSymbol: { dynamicRegistration: false },
			},
			workspace: {
				workspaceFolders: true,
				symbol: { dynamicRegistration: false },
			},
		},
		workspaceFolders: [{ uri: filePathToUri(rootPath), name: path.basename(rootPath) }],
	};

	try {
		const initResult = await connection.sendRequest(InitializeRequest.type, initParams);
		await connection.sendNotification(InitializedNotification.type, {});

		const lspConnection: LSPConnection = {
			process: serverProcess,
			connection,
			language: actualLanguage,
			rootPath,
			rootUri: filePathToUri(rootPath),
			openDocuments: new Map(),
			capabilities: {
				definitionProvider: !!initResult.capabilities.definitionProvider,
				referencesProvider: !!initResult.capabilities.referencesProvider,
				hoverProvider: !!initResult.capabilities.hoverProvider,
				documentSymbolProvider: !!initResult.capabilities.documentSymbolProvider,
				workspaceSymbolProvider: !!initResult.capabilities.workspaceSymbolProvider,
			},
		};

		connections.set(key, lspConnection);

		// Handle server exit
		serverProcess.on("exit", () => {
			connections.delete(key);
		});

		return lspConnection;
	} catch (_error) {
		serverProcess.kill();
		return null;
	}
}

/**
 * Opens a document in the LSP server if not already open.
 * @param conn - LSP connection to use
 * @param filePath - Path to the document to open
 */
async function openDocument(conn: LSPConnection, filePath: string): Promise<void> {
	const uri = filePathToUri(filePath);

	if (conn.openDocuments.has(uri)) {
		return;
	}

	const content = fs.readFileSync(filePath, "utf-8");
	let languageId: string;

	if (conn.language === "typescript" || conn.language === "javascript") {
		if (filePath.endsWith(".tsx")) languageId = "typescriptreact";
		else if (filePath.endsWith(".jsx")) languageId = "javascriptreact";
		else if (filePath.endsWith(".ts")) languageId = "typescript";
		else languageId = "javascript";
	} else if (conn.language === "rust") {
		languageId = "rust";
	} else if (conn.language === "swift") {
		languageId = "swift";
	} else if (conn.language === "php") {
		languageId = "php";
	} else {
		languageId = "python";
	}

	await conn.connection.sendNotification(DidOpenTextDocumentNotification.type, {
		textDocument: {
			uri,
			languageId,
			version: 1,
			text: content,
		},
	});

	conn.openDocuments.set(uri, { version: 1, content });
}

/**
 * Formats an LSP location as "file:line:column" string.
 * @param loc - Location or LocationLink to format
 * @returns Formatted location string
 */
function formatLocation(loc: Location | LocationLink): string {
	const uri = "targetUri" in loc ? loc.targetUri : loc.uri;
	const range = "targetRange" in loc ? loc.targetRange : loc.range;
	const filePath = uriToFilePath(uri);
	return `${filePath}:${range.start.line + 1}:${range.start.character + 1}`;
}

/**
 * Formats an array of LSP locations as newline-separated strings.
 * @param locations - Locations to format
 * @returns Formatted locations or "No results found"
 */
function formatLocations(
	locations: (Location | LocationLink)[] | Location | LocationLink | null
): string {
	if (!locations) return "No results found";

	const locs = Array.isArray(locations) ? locations : [locations];
	if (locs.length === 0) return "No results found";

	return locs.map(formatLocation).join("\n");
}

/**
 * Formats LSP symbols as "name (kind) - location" strings.
 * @param symbols - Symbols to format
 * @returns Formatted symbols or "No symbols found"
 */
function formatSymbols(
	symbols: (SymbolInformation | DocumentSymbol | WorkspaceSymbol)[] | null
): string {
	if (!symbols || symbols.length === 0) return "No symbols found";

	return symbols
		.map((s) => {
			if ("location" in s) {
				// SymbolInformation or WorkspaceSymbol
				const loc = s.location as Location | { uri: string };
				if ("range" in loc) {
					return `${s.name} (${symbolKindToString(s.kind)}) - ${formatLocation(loc)}`;
				}
				// WorkspaceSymbol with just uri (no range)
				return `${s.name} (${symbolKindToString(s.kind)}) - ${uriToFilePath(loc.uri)}`;
			}
			// DocumentSymbol
			return `${s.name} (${symbolKindToString(s.kind)}) - line ${s.range.start.line + 1}`;
		})
		.join("\n");
}

/**
 * Converts an LSP symbol kind number to a human-readable string.
 * @param kind - Symbol kind number from LSP protocol
 * @returns Human-readable kind name
 */
function symbolKindToString(kind: number): string {
	const kinds: Record<number, string> = {
		1: "File",
		2: "Module",
		3: "Namespace",
		4: "Package",
		5: "Class",
		6: "Method",
		7: "Property",
		8: "Field",
		9: "Constructor",
		10: "Enum",
		11: "Interface",
		12: "Function",
		13: "Variable",
		14: "Constant",
		15: "String",
		16: "Number",
		17: "Boolean",
		18: "Array",
		19: "Object",
		20: "Key",
		21: "Null",
		22: "EnumMember",
		23: "Struct",
		24: "Event",
		25: "Operator",
		26: "TypeParameter",
	};
	return kinds[kind] || "Unknown";
}

/**
 * Formats LSP hover information as readable text.
 * @param hover - Hover result from LSP server
 * @returns Formatted hover text or "No hover information available"
 */
function formatHover(hover: Hover | null): string {
	if (!hover) return "No hover information available";

	const contents = hover.contents;
	if (typeof contents === "string") return contents;
	if ("value" in contents) return contents.value;
	if (Array.isArray(contents)) {
		return contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n");
	}
	return "No hover information available";
}

/**
 * Registers LSP tools for definition, references, hover, and symbol search.
 * @param pi - Extension API for registering tools and event handlers
 */
export default function lspExtension(pi: ExtensionAPI) {
	// Tool: Go to Definition
	pi.registerTool({
		name: "lsp_definition",
		label: "Go to Definition",
		description: `Jump to the definition of a symbol at a specific location in a file. Uses Language Server Protocol for precise navigation.

WHEN TO USE:
- Need to find where a function/class/variable is defined
- Navigating to imported module source
- Understanding code structure

SUPPORTED: TypeScript, Python (ty/pyright), Rust, Swift, PHP (intelephense)`,
		parameters: Type.Object({
			file: Type.String({ description: "Path to the file" }),
			line: Type.Number({ description: "Line number (1-indexed)" }),
			character: Type.Number({ description: "Character/column position (1-indexed)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = path.isAbsolute(params.file)
				? params.file
				: path.resolve(ctx.cwd, params.file);
			const language = getLanguageForFile(filePath);

			if (!language) {
				return {
					details: {},
					content: [{ type: "text", text: `Unsupported file type: ${params.file}` }],
				};
			}

			const conn = await getOrCreateConnectionForFile(language, filePath, (lang) =>
				ctx.ui.setWorkingMessage(`Starting ${lang} language server`)
			);
			ctx.ui.setWorkingMessage();
			if (!conn) {
				return {
					details: {},
					content: [
						{
							type: "text",
							text: `Language server not available for ${language}. Install: ${SERVER_CONFIGS[language].command}`,
						},
					],
				};
			}

			if (!conn.capabilities.definitionProvider) {
				return {
					details: {},
					content: [
						{ type: "text", text: "Definition provider not supported by this language server" },
					],
				};
			}

			await openDocument(conn, filePath);

			try {
				const result = await conn.connection.sendRequest(DefinitionRequest.type, {
					textDocument: { uri: filePathToUri(filePath) },
					position: { line: params.line - 1, character: params.character - 1 },
				});

				return {
					details: {},
					content: [{ type: "text", text: formatLocations(result) }],
				};
			} catch (error) {
				return {
					details: {},
					content: [{ type: "text", text: `Error: ${error}` }],
				};
			}
		},
	});

	// Tool: Find References
	pi.registerTool({
		name: "lsp_references",
		label: "Find References",
		description: `Find all references to a symbol at a specific location. Returns all files and locations where the symbol is used.

WHEN TO USE:
- Need to find all usages of a function/class/variable
- Refactoring - understanding impact of changes
- Finding callers of a function`,
		parameters: Type.Object({
			file: Type.String({ description: "Path to the file" }),
			line: Type.Number({ description: "Line number (1-indexed)" }),
			character: Type.Number({ description: "Character/column position (1-indexed)" }),
			includeDeclaration: Type.Optional(
				Type.Boolean({ description: "Include the declaration in results (default: true)" })
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = path.isAbsolute(params.file)
				? params.file
				: path.resolve(ctx.cwd, params.file);
			const language = getLanguageForFile(filePath);

			if (!language) {
				return {
					details: {},
					content: [{ type: "text", text: `Unsupported file type: ${params.file}` }],
				};
			}

			const conn = await getOrCreateConnectionForFile(language, filePath, (lang) =>
				ctx.ui.setWorkingMessage(`Starting ${lang} language server`)
			);
			ctx.ui.setWorkingMessage();
			if (!conn) {
				return {
					details: {},
					content: [{ type: "text", text: `Language server not available for ${language}` }],
				};
			}

			if (!conn.capabilities.referencesProvider) {
				return {
					details: {},
					content: [{ type: "text", text: "References provider not supported" }],
				};
			}

			await openDocument(conn, filePath);

			try {
				const result = await conn.connection.sendRequest(ReferencesRequest.type, {
					textDocument: { uri: filePathToUri(filePath) },
					position: { line: params.line - 1, character: params.character - 1 },
					context: { includeDeclaration: params.includeDeclaration ?? true },
				});

				const locations = result || [];
				return {
					details: {},
					content: [
						{
							type: "text",
							text: `Found ${locations.length} reference(s):\n${formatLocations(locations)}`,
						},
					],
				};
			} catch (error) {
				return {
					details: {},
					content: [{ type: "text", text: `Error: ${error}` }],
				};
			}
		},
	});

	// Tool: Hover (Type Info)
	pi.registerTool({
		name: "lsp_hover",
		label: "Hover Info",
		description: `Get type information and documentation for a symbol at a specific location.

WHEN TO USE:
- Need to check the type of a variable/expression
- Reading function signatures and docs
- Understanding inferred types`,
		parameters: Type.Object({
			file: Type.String({ description: "Path to the file" }),
			line: Type.Number({ description: "Line number (1-indexed)" }),
			character: Type.Number({ description: "Character/column position (1-indexed)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = path.isAbsolute(params.file)
				? params.file
				: path.resolve(ctx.cwd, params.file);
			const language = getLanguageForFile(filePath);

			if (!language) {
				return {
					details: {},
					content: [{ type: "text", text: `Unsupported file type: ${params.file}` }],
				};
			}

			const conn = await getOrCreateConnectionForFile(language, filePath, (lang) =>
				ctx.ui.setWorkingMessage(`Starting ${lang} language server`)
			);
			ctx.ui.setWorkingMessage();
			if (!conn) {
				return {
					details: {},
					content: [{ type: "text", text: `Language server not available for ${language}` }],
				};
			}

			if (!conn.capabilities.hoverProvider) {
				return {
					details: {},
					content: [{ type: "text", text: "Hover provider not supported" }],
				};
			}

			await openDocument(conn, filePath);

			try {
				const result = await conn.connection.sendRequest(HoverRequest.type, {
					textDocument: { uri: filePathToUri(filePath) },
					position: { line: params.line - 1, character: params.character - 1 },
				});

				return {
					details: {},
					content: [{ type: "text", text: formatHover(result) }],
				};
			} catch (error) {
				return {
					details: {},
					content: [{ type: "text", text: `Error: ${error}` }],
				};
			}
		},
	});

	// Tool: Document Symbols
	pi.registerTool({
		name: "lsp_symbols",
		label: "Document Symbols",
		description: `List all symbols (functions, classes, variables, etc.) in a file.

WHEN TO USE:
- Get overview of file structure
- Find specific function/class in a file
- Understanding module exports`,
		parameters: Type.Object({
			file: Type.String({ description: "Path to the file" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = path.isAbsolute(params.file)
				? params.file
				: path.resolve(ctx.cwd, params.file);
			const language = getLanguageForFile(filePath);

			if (!language) {
				return {
					details: {},
					content: [{ type: "text", text: `Unsupported file type: ${params.file}` }],
				};
			}

			const conn = await getOrCreateConnectionForFile(language, filePath, (lang) =>
				ctx.ui.setWorkingMessage(`Starting ${lang} language server`)
			);
			ctx.ui.setWorkingMessage();
			if (!conn) {
				return {
					details: {},
					content: [{ type: "text", text: `Language server not available for ${language}` }],
				};
			}

			if (!conn.capabilities.documentSymbolProvider) {
				return {
					details: {},
					content: [{ type: "text", text: "Document symbol provider not supported" }],
				};
			}

			await openDocument(conn, filePath);

			try {
				const result = await conn.connection.sendRequest(DocumentSymbolRequest.type, {
					textDocument: { uri: filePathToUri(filePath) },
				});

				return {
					details: {},
					content: [{ type: "text", text: formatSymbols(result) }],
				};
			} catch (error) {
				return {
					details: {},
					content: [{ type: "text", text: `Error: ${error}` }],
				};
			}
		},
	});

	// Tool: Workspace Symbol Search
	pi.registerTool({
		name: "lsp_workspace_symbols",
		label: "Workspace Symbols",
		description: `Search for symbols across the entire workspace/project by name.

WHEN TO USE:
- Find a function/class by name across entire project
- Don't know which file contains symbol
- Exploring unfamiliar codebase`,
		parameters: Type.Object({
			query: Type.String({ description: "Symbol name or pattern to search for" }),
			language: Type.Optional(
				Type.String({
					description: "Language to search in: 'typescript', 'python', 'rust', 'swift', or 'php'",
				})
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const language = params.language || "typescript";

			// For workspace symbols, we need an active connection
			// Find any existing connection for this language, or return helpful error
			let conn: LSPConnection | null = null;

			for (const [key, c] of connections.entries()) {
				if (key.startsWith(`${language}:`)) {
					conn = c;
					break;
				}
				// Also check fallback language for Python
				if (language === "python" && key.startsWith("python_pyright:")) {
					conn = c;
					break;
				}
			}

			if (!conn) {
				return {
					details: {},
					content: [
						{
							type: "text",
							text: `No active ${language} language server. First use lsp_symbols or lsp_definition on a ${language} file to start the server for that project.`,
						},
					],
				};
			}

			if (!conn.capabilities.workspaceSymbolProvider) {
				return {
					details: {},
					content: [{ type: "text", text: "Workspace symbol provider not supported" }],
				};
			}

			try {
				const result = await conn.connection.sendRequest(WorkspaceSymbolRequest.type, {
					query: params.query,
				});

				const symbols = result || [];
				return {
					details: {},
					content: [
						{
							type: "text",
							text: `Found ${symbols.length} symbol(s) in ${conn.rootPath}:\n${formatSymbols(symbols)}`,
						},
					],
				};
			} catch (error) {
				return {
					details: {},
					content: [{ type: "text", text: `Error: ${error}` }],
				};
			}
		},
	});

	// Tool: Check LSP Status
	pi.registerTool({
		name: "lsp_status",
		label: "LSP Status",
		description: "Check which language servers are running and their capabilities.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const lines: string[] = ["LSP Server Status:"];

			// Show running connections
			if (connections.size === 0) {
				lines.push("\nNo language servers running.");
				lines.push("Use lsp_symbols or lsp_definition on a file to start a server.");
			} else {
				lines.push(`\n${connections.size} active connection(s):`);

				for (const [_key, conn] of connections.entries()) {
					const serverName = conn.language.includes("pyright")
						? "pyright"
						: conn.language === "python"
							? "ty"
							: conn.language === "rust"
								? "rust-analyzer"
								: conn.language === "swift"
									? "sourcekit-lsp"
									: conn.language === "php"
										? "intelephense"
										: "typescript-language-server";
					lines.push(`\n${conn.language}: ${serverName}`);
					lines.push(`  Workspace: ${conn.rootPath}`);
					lines.push(
						`  Capabilities: ${Object.entries(conn.capabilities)
							.filter(([_, v]) => v)
							.map(([k]) => k.replace("Provider", ""))
							.join(", ")}`
					);
					lines.push(`  Open documents: ${conn.openDocuments.size}`);
				}
			}

			// Show available servers
			lines.push("\n--- Available Language Servers ---");
			for (const [lang, config] of Object.entries(SERVER_CONFIGS)) {
				if (lang.includes("_")) continue; // Skip fallback configs

				try {
					const which = spawn("which", [config.command]);
					const available = await new Promise<boolean>((resolve) => {
						which.on("close", (code) => resolve(code === 0));
						which.on("error", () => resolve(false));
					});

					if (available) {
						lines.push(`${lang}: ${getIcon("success")} ${config.command}`);
					} else {
						lines.push(`${lang}: ${getIcon("error")} not installed`);
						if (lang === "python") {
							lines.push("  Install: uvx ty (recommended) or npm i -g pyright");
						} else if (lang === "rust") {
							lines.push("  Install: rustup component add rust-analyzer");
						} else if (lang === "swift") {
							lines.push("  Install: Comes with Xcode (xcode-select --install)");
						} else if (lang === "php") {
							lines.push("  Install: npm i -g intelephense");
						} else {
							lines.push(`  Install: npm i -g ${config.command}`);
						}
					}
				} catch {
					lines.push(`${lang}: ? error checking`);
				}
			}

			return {
				details: {},
				content: [{ type: "text", text: lines.join("\n") }],
			};
		},
	});

	// Cleanup on extension unload — follow the LSP shutdown protocol:
	// 1. Send shutdown request and await response
	// 2. Send exit notification
	// 3. Dispose connection and kill process
	// Wrap in a timeout so unresponsive servers don't block exit.
	pi.on("session_shutdown", async () => {
		const SHUTDOWN_TIMEOUT_MS = 3_000;

		await Promise.all(
			[...connections.values()].map(async (conn) => {
				try {
					await Promise.race([
						(async () => {
							await conn.connection.sendRequest(ShutdownRequest.type);
							conn.connection.sendNotification(ExitNotification.type);
						})(),
						new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
					]);
				} catch {
					// Server may have already exited or rejected — proceed to force-kill
				}
				try {
					conn.connection.dispose();
					conn.process.kill();
				} catch {
					// Ignore cleanup errors
				}
			})
		);
		connections.clear();
	});
}
