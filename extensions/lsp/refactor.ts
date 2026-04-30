/**
 * Editor-style TypeScript refactor helpers for the LSP extension.
 *
 * The implementation uses the TypeScript language-service APIs directly. Those
 * are the same deterministic primitives tsserver exposes to editors for rename,
 * file-rename import updates, and organize-imports actions.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const require = createRequire(import.meta.url);
const LARGE_EDIT_FILE_LIMIT = 25;
const LARGE_EDIT_COUNT_LIMIT = 250;
const VENDOR_SEGMENTS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"vendor",
]);

interface TypeScriptModule {
	createLanguageService(host: LanguageServiceHost): LanguageService;
	findConfigFile(
		searchPath: string,
		fileExists: (fileName: string) => boolean,
		configName?: string
	): string | undefined;
	flattenDiagnosticMessageText(messageText: unknown, newLine: string): string;
	getDefaultLibFilePath(options: CompilerOptions): string;
	getLineAndCharacterOfPosition(sourceFile: SourceFile, position: number): LineAndCharacter;
	readConfigFile(
		fileName: string,
		readFile: (fileName: string) => string | undefined
	): ReadConfigFileResult;
	ScriptSnapshot: { fromString(text: string): ScriptSnapshot };
	ScriptTarget: { Latest: number };
	sys: {
		fileExists(fileName: string): boolean;
		readDirectory: (...args: unknown[]) => string[];
		readFile(fileName: string): string | undefined;
		useCaseSensitiveFileNames: boolean;
	};
	parseJsonConfigFileContent(
		config: unknown,
		host: ParseConfigHost,
		basePath: string
	): ParsedCommandLine;
}

interface CompilerOptions {
	readonly [key: string]: unknown;
}

interface DiagnosticLike {
	readonly messageText: unknown;
}

interface LineAndCharacter {
	readonly character: number;
	readonly line: number;
}

interface LanguageService {
	dispose(): void;
	findRenameLocations(
		fileName: string,
		position: number,
		findInStrings: boolean,
		findInComments: boolean,
		providePrefixAndSuffixTextForRename: boolean
	): readonly RenameLocation[] | undefined;
	getEditsForFileRename(
		oldFilePath: string,
		newFilePath: string,
		formatOptions: Record<string, never>,
		preferences: Record<string, unknown> | undefined
	): readonly FileTextChanges[];
	getProgram(): Program | undefined;
	getRenameInfo(fileName: string, position: number): RenameInfo;
	organizeImports(
		scope: { fileName: string; type: "file" },
		formatOptions: Record<string, never>,
		preferences: Record<string, unknown>
	): readonly FileTextChanges[];
}

interface LanguageServiceHost {
	directoryExists?(directoryName: string): boolean;
	fileExists(fileName: string): boolean;
	getCompilationSettings(): CompilerOptions;
	getCurrentDirectory(): string;
	getDefaultLibFileName(options: CompilerOptions): string;
	getScriptFileNames(): string[];
	getScriptSnapshot(fileName: string): ScriptSnapshot | undefined;
	getScriptVersion(fileName: string): string;
	readDirectory: (...args: unknown[]) => string[];
	readFile(fileName: string): string | undefined;
	useCaseSensitiveFileNames(): boolean;
}

interface ParseConfigHost {
	fileExists(fileName: string): boolean;
	readDirectory: (...args: unknown[]) => string[];
	readFile(fileName: string): string | undefined;
	useCaseSensitiveFileNames: boolean;
}

interface ParsedCommandLine {
	readonly errors: readonly DiagnosticLike[];
	readonly fileNames: readonly string[];
	readonly options: CompilerOptions;
}

interface Program {
	getSourceFile(fileName: string): SourceFile | undefined;
}

interface ReadConfigFileResult {
	readonly config?: unknown;
	readonly error?: DiagnosticLike;
}

interface RenameInfo {
	readonly canRename: boolean;
	readonly displayName?: string;
	readonly fullDisplayName?: string;
	readonly localizedErrorMessage?: string;
	readonly triggerSpan?: TextSpan;
}

interface RenameLocation {
	readonly fileName: string;
	readonly prefixText?: string;
	readonly suffixText?: string;
	readonly textSpan: TextSpan;
}

type ScriptSnapshot = unknown;

interface SourceFile {
	readonly text: string;
}

interface TextChange {
	readonly newText: string;
	readonly span: TextSpan;
}

interface FileTextChanges {
	readonly fileName: string;
	readonly isNewFile?: boolean;
	readonly textChanges: readonly TextChange[];
}

interface TextSpan {
	readonly length: number;
	readonly start: number;
}

interface TextEdit {
	readonly end: number;
	readonly newText: string;
	readonly start: number;
}

interface FileEditSet {
	readonly edits: readonly TextEdit[];
	readonly originalText: string;
}

interface StagedWorkspaceEdit {
	readonly editCount: number;
	readonly files: ReadonlyMap<string, FileEditSet>;
	readonly root: string;
}

interface StagedFileSystemChange {
	readonly createdFiles: readonly string[];
	readonly deletedFiles: readonly string[];
	readonly edit: StagedWorkspaceEdit;
	readonly nextContents: ReadonlyMap<string, string>;
}

interface RefactorToolResultDetails {
	readonly dryRun: boolean;
	readonly editCount: number;
	readonly touchedFiles: readonly string[];
}

let typescriptModuleOverride: Error | TypeScriptModule | null = null;

/**
 * Overrides the TypeScript module resolver in tests.
 *
 * @param ts - Replacement TypeScript module, or undefined to restore runtime resolution
 * @returns Nothing
 */
export function setTypeScriptModuleForRefactorTests(ts?: Error | TypeScriptModule): void {
	typescriptModuleOverride = ts ?? null;
}

/**
 * Registers editor-style refactor tools on the LSP extension.
 *
 * @param registerTool - Existing registerTool bridge from the LSP extension
 * @returns Nothing
 */
export function registerRefactorTools(registerTool: (tool: unknown) => void): void {
	registerTool({
		name: "refactor_rename_symbol",
		label: "refactor_rename_symbol",
		description: `Rename a symbol everywhere using the TypeScript language service.

Dry-run defaults to true and returns touched files plus a preview. Set dryRun:false to apply.`,
		parameters: Type.Object({
			file: Type.String({ description: "Path to the file containing the symbol" }),
			line: Type.Number({ description: "Line number (1-indexed)" }),
			character: Type.Number({ description: "Character/column position (1-indexed)" }),
			newName: Type.String({ description: "New symbol name" }),
			dryRun: Type.Optional(Type.Boolean({ description: "Preview only (default: true)" })),
			force: Type.Optional(Type.Boolean({ description: "Allow large edits on apply" })),
		}),
		async execute(
			_toolCallId: string,
			params: {
				character: number;
				dryRun?: boolean;
				file: string;
				force?: boolean;
				line: number;
				newName: string;
			},
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext
		) {
			try {
				const dryRun = params.dryRun ?? true;
				const root = normalizeRoot(ctx.cwd);
				const filePath = resolveSafePath(root, params.file);
				validateIdentifier(params.newName);
				const ts = loadTypeScript(filePath);
				const service = createProjectService(ts, root, filePath);

				try {
					const sourceFile = service.getProgram()?.getSourceFile(filePath);
					if (!sourceFile) {
						return errorResult(`TypeScript could not load ${path.relative(root, filePath)}`);
					}
					const position = positionFromLineCharacter(
						sourceFile.text,
						params.line,
						params.character
					);
					const renameInfo = service.getRenameInfo(filePath, position);
					if (!renameInfo.canRename) {
						return errorResult(
							renameInfo.localizedErrorMessage ?? "No renameable symbol at position"
						);
					}

					const locations = service.findRenameLocations(filePath, position, false, false, true);
					if (!locations || locations.length === 0) {
						return errorResult("No rename locations returned for symbol");
					}

					const staged = stageWorkspaceEdit(
						root,
						locations.map((location) => ({
							fileName: location.fileName,
							textChanges: [
								{
									newText: `${location.prefixText ?? ""}${params.newName}${location.suffixText ?? ""}`,
									span: location.textSpan,
								},
							],
						}))
					);

					return finalizeTextOnlyChange(staged, { dryRun, force: params.force ?? false });
				} finally {
					service.dispose();
				}
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
		},
	});

	registerTool({
		name: "refactor_move_file",
		label: "refactor_move_file",
		description: `Move or rename a TypeScript/JavaScript file and update imports using the TypeScript language service.

Dry-run defaults to true and returns touched files plus a preview. Set dryRun:false to apply.`,
		parameters: Type.Object({
			from: Type.String({ description: "Source file path" }),
			to: Type.String({ description: "Destination file path" }),
			updateImports: Type.Optional(Type.Boolean({ description: "Update imports (default: true)" })),
			dryRun: Type.Optional(Type.Boolean({ description: "Preview only (default: true)" })),
			force: Type.Optional(Type.Boolean({ description: "Allow large edits on apply" })),
		}),
		async execute(
			_toolCallId: string,
			params: {
				dryRun?: boolean;
				force?: boolean;
				from: string;
				to: string;
				updateImports?: boolean;
			},
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext
		) {
			try {
				const dryRun = params.dryRun ?? true;
				const root = normalizeRoot(ctx.cwd);
				const from = resolveSafePath(root, params.from);
				const to = resolveSafePath(root, params.to);
				if (!fs.existsSync(from)) return errorResult(`Source file does not exist: ${params.from}`);
				if (fs.existsSync(to)) return errorResult(`Destination already exists: ${params.to}`);

				const ts = loadTypeScript(from);
				const service = createProjectService(ts, root, from);
				try {
					const edits =
						params.updateImports === false ? [] : service.getEditsForFileRename(from, to, {}, {});
					const staged = stageFileMove(root, from, to, edits);
					return finalizeFileSystemChange(staged, { dryRun, force: params.force ?? false });
				} finally {
					service.dispose();
				}
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
		},
	});

	registerTool({
		name: "refactor_organize_imports",
		label: "refactor_organize_imports",
		description: `Organize TypeScript/JavaScript imports using the TypeScript source organize-imports action.

Dry-run defaults to true and returns touched files plus a preview. Set dryRun:false to apply.`,
		parameters: Type.Object({
			files: Type.Optional(Type.Array(Type.String(), { description: "Files to organize" })),
			dirs: Type.Optional(
				Type.Array(Type.String(), { description: "Directories to scan for TS/JS files" })
			),
			dryRun: Type.Optional(Type.Boolean({ description: "Preview only (default: true)" })),
			force: Type.Optional(Type.Boolean({ description: "Allow large edits on apply" })),
		}),
		async execute(
			_toolCallId: string,
			params: { dirs?: string[]; dryRun?: boolean; files?: string[]; force?: boolean },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext
		) {
			try {
				const dryRun = params.dryRun ?? true;
				const root = normalizeRoot(ctx.cwd);
				const files = collectOrganizeImportFiles(root, params.files, params.dirs);
				if (files.length === 0) return errorResult("No TypeScript or JavaScript files matched");

				const ts = loadTypeScript(files[0] ?? root);
				const service = createProjectService(ts, root, files[0] ?? root);
				try {
					const changes = files.flatMap((fileName) =>
						service.organizeImports({ fileName, type: "file" }, {}, {})
					);
					const staged = stageWorkspaceEdit(root, changes);
					return finalizeTextOnlyChange(staged, { dryRun, force: params.force ?? false });
				} finally {
					service.dispose();
				}
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
		},
	});
}

/**
 * Normalizes the project root used for path containment checks.
 *
 * @param cwd - Current working directory from the extension context
 * @returns Absolute normalized root path
 */
function normalizeRoot(cwd: string): string {
	return path.resolve(cwd);
}

/**
 * Loads TypeScript from the project first, then from tallow's dependencies.
 *
 * @param searchStart - File or directory used for local TypeScript lookup
 * @returns TypeScript compiler/language-service module
 */
function loadTypeScript(searchStart: string): TypeScriptModule {
	if (typescriptModuleOverride instanceof Error) throw typescriptModuleOverride;
	if (typescriptModuleOverride) return typescriptModuleOverride;

	const local = findNearestTypeScriptModule(searchStart);
	try {
		return require(local ?? "typescript") as TypeScriptModule;
	} catch (error) {
		const suffix = error instanceof Error ? `: ${error.message}` : "";
		throw new Error(`TypeScript is required for refactor tools${suffix}`);
	}
}

/**
 * Finds the nearest project-local TypeScript module.
 *
 * @param start - Directory to start searching from
 * @returns Absolute path to typescript.js, or null when missing
 */
function findNearestTypeScriptModule(start: string): string | null {
	let current =
		fs.existsSync(start) && fs.statSync(start).isFile() ? path.dirname(start) : path.resolve(start);
	const root = path.parse(current).root;
	while (true) {
		const candidate = path.join(current, "node_modules", "typescript", "lib", "typescript.js");
		if (fs.existsSync(candidate)) return candidate;
		if (current === root) return null;
		current = path.dirname(current);
	}
}

/**
 * Creates a TypeScript language service for the nearest tsconfig/jsconfig project.
 *
 * @param ts - TypeScript module
 * @param root - Project root for path validation
 * @param anchorFile - File used to locate tsconfig.json
 * @returns Language service instance
 */
function createProjectService(
	ts: TypeScriptModule,
	root: string,
	anchorFile: string
): LanguageService {
	const config = readProjectConfig(ts, root, anchorFile);
	const versions = new Map(config.fileNames.map((fileName) => [path.resolve(fileName), "0"]));
	const fileNames = new Set(config.fileNames.map((fileName) => path.resolve(fileName)));
	fileNames.add(path.resolve(anchorFile));

	const host: LanguageServiceHost = {
		directoryExists: fs.existsSync,
		fileExists: fs.existsSync,
		getCompilationSettings: () => config.options,
		getCurrentDirectory: () => root,
		getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
		getScriptFileNames: () => [...fileNames],
		getScriptSnapshot(fileName) {
			const text = fs.existsSync(fileName) ? fs.readFileSync(fileName, "utf-8") : undefined;
			return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
		},
		getScriptVersion: (fileName) => versions.get(path.resolve(fileName)) ?? "0",
		readDirectory: ts.sys.readDirectory,
		readFile: ts.sys.readFile,
		useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
	};

	return ts.createLanguageService(host);
}

/**
 * Reads the TypeScript project config nearest to the anchor file.
 *
 * @param ts - TypeScript module
 * @param root - Project root fallback
 * @param anchorFile - File used to locate project config
 * @returns Parsed command line
 */
function readProjectConfig(
	ts: TypeScriptModule,
	root: string,
	anchorFile: string
): ParsedCommandLine {
	const configPath =
		ts.findConfigFile(path.dirname(anchorFile), fs.existsSync, "tsconfig.json") ??
		ts.findConfigFile(path.dirname(anchorFile), fs.existsSync, "jsconfig.json");
	if (!configPath) {
		return {
			errors: [],
			fileNames: collectFiles(root),
			options: { allowJs: true, checkJs: false, target: ts.ScriptTarget.Latest },
		};
	}

	const raw = ts.readConfigFile(configPath, (fileName) => fs.readFileSync(fileName, "utf-8"));
	if (raw.error) {
		throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"));
	}
	const parsed = ts.parseJsonConfigFileContent(
		raw.config,
		{
			fileExists: fs.existsSync,
			readDirectory: ts.sys.readDirectory,
			readFile: ts.sys.readFile,
			useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
		},
		path.dirname(configPath)
	);
	if (parsed.errors.length > 0) {
		throw new Error(ts.flattenDiagnosticMessageText(parsed.errors[0]?.messageText, "\n"));
	}
	return parsed;
}

/**
 * Collects TS/JS source files under a root for config-less projects.
 *
 * @param root - Project root to scan
 * @returns Absolute source file paths
 */
function collectFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!VENDOR_SEGMENTS.has(entry.name)) visit(absolute);
				continue;
			}
			if (isTypeScriptLikeFile(absolute)) files.push(absolute);
		}
	};
	visit(root);
	return files;
}

/**
 * Collects files requested by the organize-imports tool.
 *
 * @param root - Project root for path validation
 * @param files - Optional explicit files
 * @param dirs - Optional directories to scan
 * @returns Absolute files to organize
 */
function collectOrganizeImportFiles(root: string, files?: string[], dirs?: string[]): string[] {
	const result = new Set<string>();
	for (const file of files ?? []) {
		const absolute = resolveSafePath(root, file);
		if (!isTypeScriptLikeFile(absolute)) continue;
		result.add(absolute);
	}
	for (const dir of dirs ?? []) {
		const absoluteDir = resolveSafePath(root, dir, { allowRoot: true });
		if (!fs.existsSync(absoluteDir) || !fs.statSync(absoluteDir).isDirectory()) {
			throw new Error(`Directory does not exist: ${dir}`);
		}
		for (const file of collectFiles(absoluteDir)) {
			resolveSafePath(root, file);
			result.add(file);
		}
	}
	if (!files && !dirs) {
		for (const file of collectFiles(root)) result.add(file);
	}
	return [...result].sort();
}

/**
 * Checks whether a path is a TS/JS source file TypeScript can refactor.
 *
 * @param filePath - File path to inspect
 * @returns True when the extension is supported
 */
function isTypeScriptLikeFile(filePath: string): boolean {
	return [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].includes(path.extname(filePath));
}

/**
 * Converts 1-indexed line/character input to a zero-based absolute offset.
 *
 * @param text - File contents
 * @param line - 1-indexed line number
 * @param character - 1-indexed character number
 * @returns Absolute text offset
 */
function positionFromLineCharacter(text: string, line: number, character: number): number {
	if (!Number.isInteger(line) || line < 1) throw new Error("line must be a positive integer");
	if (!Number.isInteger(character) || character < 1) {
		throw new Error("character must be a positive integer");
	}
	let offset = 0;
	const lines = text.split(/\n/);
	if (line > lines.length) throw new Error("line is outside the file");
	for (let index = 0; index < line - 1; index++) offset += (lines[index]?.length ?? 0) + 1;
	const lineText = lines[line - 1] ?? "";
	if (character - 1 > lineText.length) throw new Error("character is outside the line");
	return offset + character - 1;
}

/**
 * Validates a TypeScript identifier-ish rename target.
 *
 * @param newName - Proposed symbol name
 * @returns Nothing
 */
function validateIdentifier(newName: string): void {
	if (!/^[$A-Z_a-z][$\w]*$/.test(newName)) {
		throw new Error(`Invalid TypeScript identifier: ${newName}`);
	}
}

/**
 * Resolves and validates a path is inside the project and outside generated/vendor dirs.
 *
 * @param root - Project root
 * @param input - User-provided path
 * @returns Absolute normalized path
 */
function resolveSafePath(
	root: string,
	input: string,
	options: { readonly allowRoot?: boolean } = {}
): string {
	const absolute = path.resolve(root, input);
	const relative = path.relative(root, absolute);
	if (relative === "") {
		if (options.allowRoot) return absolute;
		throw new Error(`Refusing to touch project root as a file: ${input}`);
	}
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Refusing to touch path outside project root: ${input}`);
	}
	const segments = relative.split(path.sep);
	const blocked = segments.find((segment) => VENDOR_SEGMENTS.has(segment));
	if (blocked) throw new Error(`Refusing to touch path under ${blocked}: ${input}`);
	return absolute;
}

/**
 * Stages TypeScript text changes into a deterministic workspace edit.
 *
 * @param root - Project root
 * @param changes - TypeScript file text changes
 * @returns Staged workspace edit
 */
export function stageWorkspaceEdit(
	root: string,
	changes: readonly FileTextChanges[]
): StagedWorkspaceEdit {
	const grouped = new Map<string, TextEdit[]>();
	let editCount = 0;

	for (const change of changes) {
		const fileName = resolveSafePath(root, change.fileName);
		if (!fs.existsSync(fileName) && !change.isNewFile) {
			throw new Error(`Cannot edit missing file: ${path.relative(root, fileName)}`);
		}
		const existing = grouped.get(fileName) ?? [];
		for (const textChange of change.textChanges) {
			existing.push({
				end: textChange.span.start + textChange.span.length,
				newText: textChange.newText,
				start: textChange.span.start,
			});
			editCount++;
		}
		grouped.set(fileName, existing);
	}

	const files = new Map<string, FileEditSet>();
	for (const [fileName, edits] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const originalText = fs.existsSync(fileName) ? fs.readFileSync(fileName, "utf-8") : "";
		const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
		validateEdits(originalText, sorted, fileName, root);
		files.set(fileName, { edits: sorted, originalText });
	}

	return { editCount, files, root };
}

/**
 * Stages a file move plus optional import-update edits.
 *
 * @param root - Project root
 * @param from - Existing source path
 * @param to - Destination path
 * @param importEdits - TypeScript import edits
 * @returns Staged filesystem change
 */
function stageFileMove(
	root: string,
	from: string,
	to: string,
	importEdits: readonly FileTextChanges[]
): StagedFileSystemChange {
	const stagedEdit = stageWorkspaceEdit(root, importEdits);
	const nextContents = buildNextContents(stagedEdit);
	const movedContent = nextContents.get(from) ?? fs.readFileSync(from, "utf-8");
	nextContents.delete(from);
	nextContents.set(to, movedContent);
	return {
		createdFiles: [to],
		deletedFiles: [from],
		edit: stagedEdit,
		nextContents,
	};
}

/**
 * Validates edits are within bounds and do not overlap.
 *
 * @param text - Original file text
 * @param reverseSortedEdits - Edits sorted descending by start offset
 * @param fileName - File being edited
 * @param root - Project root for messages
 * @returns Nothing
 */
function validateEdits(
	text: string,
	reverseSortedEdits: readonly TextEdit[],
	fileName: string,
	root: string
): void {
	let previousStart = text.length + 1;
	for (const edit of reverseSortedEdits) {
		if (edit.start < 0 || edit.end < edit.start || edit.end > text.length) {
			throw new Error(`Invalid edit span in ${path.relative(root, fileName)}`);
		}
		if (edit.end > previousStart) {
			throw new Error(`Overlapping edits in ${path.relative(root, fileName)}`);
		}
		previousStart = edit.start;
	}
}

/**
 * Applies edits to a text string in reverse-position order.
 *
 * @param text - Original file text
 * @param reverseSortedEdits - Edits sorted descending by start offset
 * @returns Edited text
 */
export function applyTextEdits(text: string, reverseSortedEdits: readonly TextEdit[]): string {
	let next = text;
	for (const edit of reverseSortedEdits) {
		next = `${next.slice(0, edit.start)}${edit.newText}${next.slice(edit.end)}`;
	}
	return next;
}

/**
 * Computes next file contents for every edited file.
 *
 * @param staged - Staged text-only workspace edit
 * @returns Map of absolute file path to new contents
 */
function buildNextContents(staged: StagedWorkspaceEdit): Map<string, string> {
	const next = new Map<string, string>();
	for (const [fileName, fileEdit] of staged.files) {
		next.set(fileName, applyTextEdits(fileEdit.originalText, fileEdit.edits));
	}
	return next;
}

/**
 * Produces and optionally applies a text-only workspace edit.
 *
 * @param staged - Staged edit
 * @param options - Dry-run, force, and guard settings
 * @returns Agent tool result
 */
function finalizeTextOnlyChange(
	staged: StagedWorkspaceEdit,
	options: { readonly dryRun: boolean; readonly force: boolean }
): {
	content: { text: string; type: "text" }[];
	details: RefactorToolResultDetails;
	isError?: boolean;
} {
	const nextContents = buildNextContents(staged);
	if (!options.dryRun) {
		guardLargeEdit(staged, options.force);
		writeAll(nextContents, []);
	}
	return successResult(staged, nextContents, options.dryRun, [], []);
}

/**
 * Produces and optionally applies a file move and import edits.
 *
 * @param staged - Staged file-system change
 * @param options - Dry-run, force, and guard settings
 * @returns Agent tool result
 */
function finalizeFileSystemChange(
	staged: StagedFileSystemChange,
	options: { readonly dryRun: boolean; readonly force: boolean }
): {
	content: { text: string; type: "text" }[];
	details: RefactorToolResultDetails;
	isError?: boolean;
} {
	if (!options.dryRun) {
		guardLargeEdit(staged.edit, options.force);
		writeAll(staged.nextContents, staged.deletedFiles);
	}
	return successResult(
		staged.edit,
		staged.nextContents,
		options.dryRun,
		staged.createdFiles,
		staged.deletedFiles
	);
}

/**
 * Rejects large non-dry-run edits unless force is set.
 *
 * @param staged - Staged edit to inspect
 * @param force - Whether the caller explicitly allows large edits
 * @returns Nothing
 */
function guardLargeEdit(staged: StagedWorkspaceEdit, force: boolean): void {
	if (force) return;
	if (staged.files.size > LARGE_EDIT_FILE_LIMIT || staged.editCount > LARGE_EDIT_COUNT_LIMIT) {
		throw new Error(
			`Refactor touches ${staged.files.size} files and ${staged.editCount} edits; rerun with force:true to apply`
		);
	}
}

/**
 * Writes all staged contents after validation, then removes deleted files.
 *
 * @param nextContents - Files and final contents to write
 * @param deletedFiles - Files to remove after writes succeed
 * @returns Nothing
 */
function writeAll(
	nextContents: ReadonlyMap<string, string>,
	deletedFiles: readonly string[]
): void {
	try {
		for (const [fileName, content] of nextContents) {
			fs.mkdirSync(path.dirname(fileName), { recursive: true });
			fs.writeFileSync(fileName, content, "utf-8");
		}
		for (const fileName of deletedFiles) fs.rmSync(fileName, { force: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Refactor write failed after staging validation; filesystem may be partially updated: ${message}`
		);
	}
}

/**
 * Builds a successful tool result with preview text.
 *
 * @param staged - Staged edit metadata
 * @param nextContents - Next file contents
 * @param dryRun - Whether this was preview-only
 * @param createdFiles - Created/moved destination files
 * @param deletedFiles - Deleted/moved source files
 * @returns Tool result
 */
function successResult(
	staged: StagedWorkspaceEdit,
	nextContents: ReadonlyMap<string, string>,
	dryRun: boolean,
	createdFiles: readonly string[],
	deletedFiles: readonly string[]
): { content: { text: string; type: "text" }[]; details: RefactorToolResultDetails } {
	const touched = [...new Set([...staged.files.keys(), ...createdFiles, ...deletedFiles])].sort();
	const relative = touched.map((fileName) => path.relative(staged.root, fileName));
	const header = [
		`${dryRun ? "Preview" : "Applied"}: ${touched.length} file(s), ${staged.editCount} edit(s)`,
		...relative.map((fileName) => `- ${fileName}`),
	];
	const diff = renderPreview(staged.root, staged.files, nextContents, createdFiles, deletedFiles);
	return {
		content: [{ type: "text", text: `${header.join("\n")}\n\n${diff}` }],
		details: { dryRun, editCount: staged.editCount, touchedFiles: relative },
	};
}

/**
 * Builds a safe error tool result.
 *
 * @param message - Error message to show the agent
 * @returns Tool error result
 */
function errorResult(message: string): {
	content: { text: string; type: "text" }[];
	details: object;
	isError: true;
} {
	return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

/**
 * Renders a unified diff-like preview for changed files.
 *
 * @param root - Project root for relative paths
 * @param originalFiles - Original file edit map
 * @param nextContents - Next file contents
 * @param createdFiles - Newly created files
 * @param deletedFiles - Deleted files
 * @returns Preview text
 */
function renderPreview(
	root: string,
	originalFiles: ReadonlyMap<string, FileEditSet>,
	nextContents: ReadonlyMap<string, string>,
	createdFiles: readonly string[],
	deletedFiles: readonly string[]
): string {
	const files = [
		...new Set([...originalFiles.keys(), ...nextContents.keys(), ...createdFiles, ...deletedFiles]),
	].sort();
	if (files.length === 0) return "No changes.";
	return files
		.map((fileName) => {
			const relative = path.relative(root, fileName);
			const original =
				originalFiles.get(fileName)?.originalText ??
				(fs.existsSync(fileName) ? fs.readFileSync(fileName, "utf-8") : "");
			const next = deletedFiles.includes(fileName) ? "" : (nextContents.get(fileName) ?? original);
			return renderFileDiff(relative, original, next);
		})
		.join("\n");
}

/**
 * Renders a compact unified diff for one file.
 *
 * @param relativePath - Display path
 * @param original - Original contents
 * @param next - New contents
 * @returns Diff text
 */
function renderFileDiff(relativePath: string, original: string, next: string): string {
	if (original === next) return `--- ${relativePath}\n+++ ${relativePath}\n(no textual changes)\n`;
	const oldLines = splitLines(original);
	const newLines = splitLines(next);
	return [`--- ${relativePath}`, `+++ ${relativePath}`, ...buildLineDiff(oldLines, newLines)].join(
		"\n"
	);
}

/**
 * Splits text into stable display lines without adding phantom trailing lines.
 *
 * @param text - Text to split
 * @returns Lines for diffing
 */
function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

/**
 * Builds a small LCS-based line diff.
 *
 * @param oldLines - Original lines
 * @param newLines - New lines
 * @returns Diff body lines
 */
function buildLineDiff(oldLines: readonly string[], newLines: readonly string[]): string[] {
	const table = Array.from({ length: oldLines.length + 1 }, () =>
		Array<number>(newLines.length + 1).fill(0)
	);
	for (let i = oldLines.length - 1; i >= 0; i--) {
		const row = table[i];
		if (!row) continue;
		for (let j = newLines.length - 1; j >= 0; j--) {
			row[j] =
				oldLines[i] === newLines[j]
					? (table[i + 1]?.[j + 1] ?? 0) + 1
					: Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
		}
	}

	const diff: string[] = [];
	let i = 0;
	let j = 0;
	while (i < oldLines.length || j < newLines.length) {
		if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
			diff.push(` ${oldLines[i]}`);
			i++;
			j++;
		} else if (
			j < newLines.length &&
			(i === oldLines.length || (table[i]?.[j + 1] ?? 0) >= (table[i + 1]?.[j] ?? 0))
		) {
			diff.push(`+${newLines[j]}`);
			j++;
		} else if (i < oldLines.length) {
			diff.push(`-${oldLines[i]}`);
			i++;
		}
	}
	return diff;
}
