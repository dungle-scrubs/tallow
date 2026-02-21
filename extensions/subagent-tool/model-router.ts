/**
 * Model routing orchestrator.
 *
 * Loads routing config, runs the selection algorithm (from synapse),
 * and exposes the main `routeModel` entry point consumed by the
 * subagent tool.
 *
 * Supports per-call routing hints so the parent LLM can express
 * intent (cost preference, task type, complexity) without picking
 * a specific model.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ClassificationResult,
	CostPreference,
	ResolvedModel,
	SelectionOptions,
	TaskType,
} from "@dungle-scrubs/synapse";
import * as synapse from "@dungle-scrubs/synapse";
import {
	listAvailableModels,
	resolveModelCandidates,
	resolveModelFuzzy,
	selectModels,
} from "@dungle-scrubs/synapse";
import { classifyTask } from "./task-classifier.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Supported score-based routing modes. */
export type RoutingMode = "balanced" | "cheap" | "fast" | "quality" | "reliable";

/** Mode-policy override map keyed by routing mode. */
export type RoutingModePolicyOverrides = Partial<Record<RoutingMode, RoutingModePolicyOverride>>;

/** Partial mode-policy override payload (passed through to synapse). */
export interface RoutingModePolicyOverride {
	readonly complexityBias?: number;
	readonly constraints?: {
		readonly maxErrorRate?: number;
		readonly maxLatencyP90Ms?: number;
		readonly minUptime?: number;
	};
	readonly taskFloors?: Partial<Record<TaskType, number>>;
	readonly weights?: {
		readonly capability?: number;
		readonly cost?: number;
		readonly latency?: number;
		readonly reliability?: number;
		readonly throughput?: number;
	};
}

/** Matrix override payload passed into synapse selector options. */
export type MatrixOverrides = Readonly<
	Record<string, Readonly<Partial<Record<TaskType, number>>> | null>
>;

/** Routing telemetry snapshot payload passed into synapse selector options. */
export interface RoutingSignalsSnapshot {
	readonly generatedAtMs: number;
	readonly models?: Readonly<Record<string, unknown>>;
	readonly routes?: Readonly<Record<string, unknown>>;
}

/** Configuration for the routing engine (from settings.json). */
export interface RoutingConfig {
	/** User's cost preference. */
	costPreference: CostPreference;
	/** Whether auto-routing is enabled. */
	enabled: boolean;
	/** Optional matrix override JSON path. */
	matrixOverridesPath?: string;
	/** Optional mode policy override map. */
	modePolicyOverrides?: RoutingModePolicyOverrides;
	/** Score-based routing mode. */
	mode: RoutingMode;
	/** Agent's default task type. */
	primaryType: TaskType;
	/** Max age for telemetry snapshots in milliseconds. */
	signalsMaxAgeMs: number;
	/** Optional telemetry snapshot JSON path. */
	signalsSnapshotPath?: string;
}

/** Selection options extended with forward-compatible routing payload fields. */
type SelectionOptionsWithRouting = SelectionOptions & {
	matrixOverrides?: MatrixOverrides;
	routingMode?: RoutingMode;
	routingModePolicyOverride?: RoutingModePolicyOverride;
	routingSignals?: RoutingSignalsSnapshot;
};

/**
 * Per-call routing hints from the parent LLM.
 *
 * These override the global settings and/or the classifier output
 * for a single subagent invocation.
 */
export interface RoutingHints {
	/** Cost preference — overrides global setting. */
	costPreference?: CostPreference;
	/** Task type — skips classifier's type detection. */
	taskType?: TaskType;
	/** Complexity (1-5) — skips classifier's complexity detection. */
	complexity?: number;
	/**
	 * Constrain auto-routing to a model family via fuzzy match.
	 *
	 * When set, the auto-router only considers models matching this query
	 * (e.g. "codex" → only codex models, "gemini" → only Gemini models).
	 * The task is still classified and models are still filtered by capability
	 * and sorted by cost preference — but only within the scoped pool.
	 *
	 * Has no effect when an explicit model override is provided.
	 */
	modelScope?: string;
}

/** Result of the model routing decision. */
export type RoutingResult = RoutingSuccess | RoutingError;

/** Successful routing — a ranked list of candidate models. */
export interface RoutingSuccess {
	ok: true;
	/** The top-ranked model. */
	model: ResolvedModel;
	/** Fallback candidates in priority order (excludes the top pick). */
	fallbacks: ResolvedModel[];
	/** How the model was selected. */
	reason: "explicit" | "agent-frontmatter" | "auto-routed" | "scoped-auto-routed" | "fallback";
	/** Classification result if auto-routing was used. */
	classification?: ClassificationResult;
}

/** Failed routing — the user's explicit model couldn't be resolved. */
export interface RoutingError {
	ok: false;
	/** The model string that failed to resolve. */
	query: string;
	/** Human-readable error message. */
	error: string;
}

// Re-export CostPreference for consumers that import it from model-router
export type { CostPreference, TaskType } from "@dungle-scrubs/synapse";

// ─── Settings ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RoutingConfig = {
	costPreference: "balanced",
	enabled: true,
	mode: "balanced",
	primaryType: "code",
	signalsMaxAgeMs: 1_800_000,
};

const VALID_COST_PREFS = new Set<CostPreference>(["eco", "balanced", "premium"]);
const VALID_ROUTING_MODES = new Set<RoutingMode>([
	"balanced",
	"cheap",
	"fast",
	"quality",
	"reliable",
]);
const VALID_TASK_TYPES = new Set<TaskType>(["code", "vision", "text"]);

interface RawRoutingConfig {
	costPreference?: unknown;
	enabled?: unknown;
	matrixOverridesPath?: unknown;
	mode?: unknown;
	modePolicyOverrides?: unknown;
	primaryType?: unknown;
	signalsMaxAgeMs?: unknown;
	signalsSnapshotPath?: unknown;
}

/**
 * Reads the raw `routing` object from a settings file.
 *
 * @param settingsPath - Absolute path to settings.json
 * @returns Raw routing object, or undefined when absent/unreadable
 */
function readRawRoutingConfig(settingsPath: string): RawRoutingConfig | undefined {
	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as { routing?: unknown };
		if (typeof parsed.routing !== "object" || parsed.routing === null) {
			return undefined;
		}
		return parsed.routing as RawRoutingConfig;
	} catch {
		return undefined;
	}
}

/**
 * Resolve a boolean routing field with project > user > default precedence.
 *
 * @param projectValue - Project-level raw field value
 * @param userValue - User-level raw field value
 * @param fallback - Default fallback value
 * @returns Resolved boolean value
 */
function resolveBooleanField(
	projectValue: unknown,
	userValue: unknown,
	fallback: boolean
): boolean {
	if (typeof projectValue === "boolean") return projectValue;
	if (typeof userValue === "boolean") return userValue;
	return fallback;
}

/**
 * Resolve a typed enum routing field with project > user > default precedence.
 *
 * @param projectValue - Project-level raw field value
 * @param userValue - User-level raw field value
 * @param validValues - Set of accepted enum values
 * @param fallback - Default fallback value
 * @returns Resolved enum value
 */
function resolveEnumField<T extends string>(
	projectValue: unknown,
	userValue: unknown,
	validValues: Set<T>,
	fallback: T
): T {
	if (typeof projectValue === "string" && validValues.has(projectValue as T)) {
		return projectValue as T;
	}
	if (typeof userValue === "string" && validValues.has(userValue as T)) {
		return userValue as T;
	}
	return fallback;
}

/**
 * Check whether a value is a plain object record.
 *
 * @param value - Value to test
 * @returns True when value is an object record
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve an optional string field with project > user precedence.
 *
 * @param projectValue - Project-level raw field value
 * @param userValue - User-level raw field value
 * @returns Non-empty string when available
 */
function resolveOptionalStringField(projectValue: unknown, userValue: unknown): string | undefined {
	if (typeof projectValue === "string" && projectValue.length > 0) return projectValue;
	if (typeof userValue === "string" && userValue.length > 0) return userValue;
	return undefined;
}

/**
 * Resolve a positive-number field with project > user > default precedence.
 *
 * @param projectValue - Project-level raw field value
 * @param userValue - User-level raw field value
 * @param fallback - Default fallback value
 * @returns Resolved positive number
 */
function resolvePositiveNumberField(
	projectValue: unknown,
	userValue: unknown,
	fallback: number
): number {
	if (typeof projectValue === "number" && Number.isFinite(projectValue) && projectValue > 0) {
		return projectValue;
	}
	if (typeof userValue === "number" && Number.isFinite(userValue) && userValue > 0) {
		return userValue;
	}
	return fallback;
}

/**
 * Parse and sanitize a single mode-policy override object.
 *
 * @param value - Raw override payload
 * @returns Sanitized override or undefined when invalid
 */
function parseModePolicyOverride(value: unknown): RoutingModePolicyOverride | undefined {
	if (!isRecord(value)) return undefined;

	const parsed: {
		complexityBias?: number;
		constraints?: { maxErrorRate?: number; maxLatencyP90Ms?: number; minUptime?: number };
		taskFloors?: Partial<Record<TaskType, number>>;
		weights?: {
			capability?: number;
			cost?: number;
			latency?: number;
			reliability?: number;
			throughput?: number;
		};
	} = {};

	if (typeof value.complexityBias === "number" && Number.isFinite(value.complexityBias)) {
		parsed.complexityBias = value.complexityBias;
	}

	if (isRecord(value.constraints)) {
		const constraints: { maxErrorRate?: number; maxLatencyP90Ms?: number; minUptime?: number } = {};
		if (
			typeof value.constraints.maxErrorRate === "number" &&
			Number.isFinite(value.constraints.maxErrorRate)
		) {
			constraints.maxErrorRate = value.constraints.maxErrorRate;
		}
		if (
			typeof value.constraints.maxLatencyP90Ms === "number" &&
			Number.isFinite(value.constraints.maxLatencyP90Ms)
		) {
			constraints.maxLatencyP90Ms = value.constraints.maxLatencyP90Ms;
		}
		if (
			typeof value.constraints.minUptime === "number" &&
			Number.isFinite(value.constraints.minUptime)
		) {
			constraints.minUptime = value.constraints.minUptime;
		}
		if (Object.keys(constraints).length > 0) parsed.constraints = constraints;
	}

	if (isRecord(value.taskFloors)) {
		const taskFloors: Partial<Record<TaskType, number>> = {};
		for (const taskType of ["code", "vision", "text"] as const) {
			const floor = value.taskFloors[taskType];
			if (typeof floor === "number" && Number.isFinite(floor) && floor >= 1 && floor <= 5) {
				taskFloors[taskType] = floor;
			}
		}
		if (Object.keys(taskFloors).length > 0) parsed.taskFloors = taskFloors;
	}

	if (isRecord(value.weights)) {
		const weights: {
			capability?: number;
			cost?: number;
			latency?: number;
			reliability?: number;
			throughput?: number;
		} = {};
		for (const key of ["capability", "cost", "latency", "reliability", "throughput"] as const) {
			const weight = value.weights[key];
			if (typeof weight === "number" && Number.isFinite(weight) && weight >= 0) {
				weights[key] = weight;
			}
		}
		if (Object.keys(weights).length > 0) parsed.weights = weights;
	}

	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

/**
 * Parse and sanitize the mode-policy override map.
 *
 * @param value - Raw override-map payload
 * @returns Sanitized override map or undefined when invalid
 */
function parseModePolicyOverrides(value: unknown): RoutingModePolicyOverrides | undefined {
	if (!isRecord(value)) return undefined;
	const parsed: RoutingModePolicyOverrides = {};
	for (const [mode, overrideValue] of Object.entries(value)) {
		if (!VALID_ROUTING_MODES.has(mode as RoutingMode)) continue;
		const override = parseModePolicyOverride(overrideValue);
		if (override) parsed[mode as RoutingMode] = override;
	}
	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

/**
 * Resolve mode-policy overrides with project > user precedence.
 *
 * @param projectValue - Project-level raw field value
 * @param userValue - User-level raw field value
 * @returns Sanitized mode-policy overrides
 */
function resolveModePolicyOverridesField(
	projectValue: unknown,
	userValue: unknown
): RoutingModePolicyOverrides | undefined {
	const projectOverrides = parseModePolicyOverrides(projectValue);
	if (projectOverrides) return projectOverrides;
	return parseModePolicyOverrides(userValue);
}

/**
 * Loads routing configuration from settings files.
 *
 * Reads from:
 * 1) `~/.tallow/settings.json` (user-level)
 * 2) `<cwd>/.tallow/settings.json` (project-level, overrides user-level)
 *
 * Invalid values fall back to lower-precedence values, then defaults.
 *
 * @param cwd - Working directory used for project-local settings
 * @returns Merged routing config
 */
export function loadRoutingConfig(cwd: string = process.cwd()): RoutingConfig {
	const home = process.env.HOME || os.homedir();
	const userSettingsPath = path.join(home, ".tallow", "settings.json");
	const projectSettingsPath = path.join(cwd, ".tallow", "settings.json");

	const userRouting = readRawRoutingConfig(userSettingsPath);
	const projectRouting = readRawRoutingConfig(projectSettingsPath);

	return {
		costPreference: resolveEnumField(
			projectRouting?.costPreference,
			userRouting?.costPreference,
			VALID_COST_PREFS,
			DEFAULT_CONFIG.costPreference
		),
		enabled: resolveBooleanField(
			projectRouting?.enabled,
			userRouting?.enabled,
			DEFAULT_CONFIG.enabled
		),
		matrixOverridesPath: resolveOptionalStringField(
			projectRouting?.matrixOverridesPath,
			userRouting?.matrixOverridesPath
		),
		mode: resolveEnumField(
			projectRouting?.mode,
			userRouting?.mode,
			VALID_ROUTING_MODES,
			DEFAULT_CONFIG.mode
		),
		modePolicyOverrides: resolveModePolicyOverridesField(
			projectRouting?.modePolicyOverrides,
			userRouting?.modePolicyOverrides
		),
		primaryType: resolveEnumField(
			projectRouting?.primaryType,
			userRouting?.primaryType,
			VALID_TASK_TYPES,
			DEFAULT_CONFIG.primaryType
		),
		signalsMaxAgeMs: resolvePositiveNumberField(
			projectRouting?.signalsMaxAgeMs,
			userRouting?.signalsMaxAgeMs,
			DEFAULT_CONFIG.signalsMaxAgeMs
		),
		signalsSnapshotPath: resolveOptionalStringField(
			projectRouting?.signalsSnapshotPath,
			userRouting?.signalsSnapshotPath
		),
	};
}

// ─── Routing Data Sources ────────────────────────────────────────────────────

/**
 * Resolve a settings-configured path into an absolute path.
 *
 * Supports:
 * - `~/...` (HOME expansion)
 * - absolute paths
 * - relative paths resolved from `cwd`
 *
 * @param cwd - Working directory for relative path resolution
 * @param configuredPath - Raw path string from settings
 * @returns Absolute file path
 */
function resolveConfiguredPath(cwd: string, configuredPath: string): string {
	const home = process.env.HOME || os.homedir();
	if (configuredPath.startsWith("~/")) {
		return path.join(home, configuredPath.slice(2));
	}
	if (path.isAbsolute(configuredPath)) return configuredPath;
	return path.resolve(cwd, configuredPath);
}

/**
 * Read and parse a JSON file.
 *
 * @param filePath - Absolute JSON file path
 * @returns Parsed JSON payload, or undefined when unreadable/invalid
 */
function readJsonFile(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * Parse matrix overrides in a backward-compatible way.
 *
 * Uses synapse's parser when available, otherwise falls back to local
 * validation logic with the same accepted shapes.
 *
 * @param input - Raw JSON payload from override file
 * @returns Sanitized matrix override map
 */
function parseMatrixOverrides(input: unknown): MatrixOverrides | undefined {
	const parser = (synapse as Record<string, unknown>).parseModelMatrixOverrides;
	if (typeof parser === "function") {
		const parsed = (parser as (payload: unknown) => MatrixOverrides | undefined)(input);
		if (parsed && isRecord(parsed)) return parsed;
	}

	const root =
		isRecord(input) && Object.hasOwn(input, "matrixOverrides")
			? (input as { matrixOverrides?: unknown }).matrixOverrides
			: input;
	if (!isRecord(root)) return undefined;

	const parsed: Record<string, Readonly<Partial<Record<TaskType, number>>> | null> = {};
	for (const [modelPrefix, override] of Object.entries(root)) {
		if (override === null) {
			parsed[modelPrefix] = null;
			continue;
		}
		if (!isRecord(override)) continue;
		const ratings: Partial<Record<TaskType, number>> = {};
		for (const taskType of ["code", "vision", "text"] as const) {
			const rating = override[taskType];
			if (typeof rating === "number" && Number.isInteger(rating) && rating >= 1 && rating <= 5) {
				ratings[taskType] = rating;
			}
		}
		if (Object.keys(ratings).length > 0) parsed[modelPrefix] = ratings;
	}

	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

/**
 * Load matrix overrides from the configured file path.
 *
 * @param cwd - Working directory for relative path resolution
 * @param config - Effective routing config
 * @returns Parsed matrix overrides, or undefined when unavailable/invalid
 */
export function loadMatrixOverrides(
	cwd: string,
	config: RoutingConfig
): MatrixOverrides | undefined {
	if (!config.matrixOverridesPath) return undefined;
	const absolutePath = resolveConfiguredPath(cwd, config.matrixOverridesPath);
	return parseMatrixOverrides(readJsonFile(absolutePath));
}

/**
 * Load routing telemetry snapshot from the configured file path.
 *
 * Drops snapshots older than `signalsMaxAgeMs` based on `generatedAtMs`.
 *
 * @param cwd - Working directory for relative path resolution
 * @param config - Effective routing config
 * @returns Fresh telemetry snapshot, or undefined when stale/unavailable/invalid
 */
export function loadRoutingSignalsSnapshot(
	cwd: string,
	config: RoutingConfig
): RoutingSignalsSnapshot | undefined {
	if (!config.signalsSnapshotPath) return undefined;
	const absolutePath = resolveConfiguredPath(cwd, config.signalsSnapshotPath);
	const payload = readJsonFile(absolutePath);
	if (!isRecord(payload)) return undefined;
	if (typeof payload.generatedAtMs !== "number" || !Number.isFinite(payload.generatedAtMs)) {
		return undefined;
	}
	if (Date.now() - payload.generatedAtMs > config.signalsMaxAgeMs) return undefined;
	return {
		generatedAtMs: payload.generatedAtMs,
		models: isRecord(payload.models) ? payload.models : undefined,
		routes: isRecord(payload.routes) ? payload.routes : undefined,
	};
}

// ─── Subscription Provider Detection ─────────────────────────────────────────

/**
 * Reads auth.json and returns provider names that use OAuth (subscription) auth.
 *
 * Subscription providers (e.g. openai-codex for ChatGPT Plus/Pro, github-copilot)
 * are preferred over pay-per-token API providers when models tie on cost/rating.
 *
 * @returns Array of provider names with OAuth credentials, or empty if none
 */
function getSubscriptionProviders(): string[] {
	try {
		const authPath = path.join(os.homedir(), ".tallow", "auth.json");
		const raw = fs.readFileSync(authPath, "utf-8");
		const data = JSON.parse(raw) as Record<string, { type?: string }>;
		return Object.entries(data)
			.filter(([, cred]) => cred?.type === "oauth")
			.map(([provider]) => provider);
	} catch {
		return [];
	}
}

// ─── Routing Keywords ────────────────────────────────────────────────────────

/**
 * Maps routing keyword strings from agent frontmatter to cost preferences.
 *
 * When an agent's `model` field is set to one of these keywords instead of
 * an actual model name, the routing engine skips fuzzy model resolution and
 * instead forces auto-routing with the corresponding cost preference.
 *
 * Examples: `model: auto-cheap` → eco routing, `model: auto-premium` → premium routing.
 */
const ROUTING_KEYWORDS: ReadonlyMap<string, CostPreference> = new Map([
	["auto-cheap", "eco"],
	["auto-eco", "eco"],
	["auto-balanced", "balanced"],
	["auto-premium", "premium"],
]);

/**
 * Parse a model string as a routing keyword.
 *
 * @param model - Model string from agent frontmatter
 * @returns Cost preference if the string is a routing keyword, undefined otherwise
 */
export function parseRoutingKeyword(model: string): CostPreference | undefined {
	return ROUTING_KEYWORDS.get(model.toLowerCase().trim());
}

/**
 * Convert a cost preference into its equivalent score-based routing mode.
 *
 * This preserves historical semantics where costPreference materially changes
 * ranking behavior, not just tie-break behavior.
 *
 * @param costPreference - Effective cost preference
 * @returns Routing mode aligned with the preference
 */
function costPreferenceToRoutingMode(costPreference: CostPreference): RoutingMode {
	if (costPreference === "eco") return "cheap";
	if (costPreference === "premium") return "quality";
	return "balanced";
}

// ─── Routing ─────────────────────────────────────────────────────────────────

/**
 * Builds a fallback ResolvedModel from a parent model ID.
 *
 * @param parentModelId - Parent session's model ID
 * @returns Resolved model for fallback use
 */
function resolveFallback(parentModelId: string): ResolvedModel {
	const resolved = resolveModelFuzzy(parentModelId);
	if (resolved) return resolved;
	return { provider: "unknown", id: parentModelId, displayName: parentModelId };
}

/**
 * Route a subagent task to the best model(s).
 *
 * Decision flow:
 * 1. If modelOverride provided → fuzzy resolve it, return as "explicit"
 * 2. If agentModel provided (from frontmatter) → fuzzy resolve, return as "agent-frontmatter"
 * 3. If routing disabled → return parentModel as "fallback"
 * 4. Auto-route: classify task (or use per-call hints), select ranked
 *    candidates, return top pick + fallbacks as "auto-routed"
 * 5. If no candidates found → return parentModel as "fallback"
 *
 * Per-call hints override individual fields:
 * - hints.costPreference → overrides global costPreference
 * - hints.taskType → overrides classifier's type detection
 * - hints.complexity → overrides classifier's complexity detection
 *
 * @param task - Task description
 * @param modelOverride - Per-call explicit model (from params.model)
 * @param agentModel - Model from agent frontmatter
 * @param parentModelId - Parent session's model ID (inheritance fallback)
 * @param agentRole - Optional agent role for classifier context
 * @param hints - Optional per-call routing hints from parent LLM
 * @param cwd - Working directory used for project-local routing settings
 * @returns Routing result with model, fallbacks, and reason
 */
export async function routeModel(
	task: string,
	modelOverride?: string,
	agentModel?: string,
	parentModelId?: string,
	agentRole?: string,
	hints?: RoutingHints,
	cwd?: string
): Promise<RoutingResult> {
	// 1. Explicit per-call model override — fuzzy resolve to best match
	if (modelOverride) {
		const resolved = resolveModelFuzzy(modelOverride);
		if (resolved) return { ok: true, model: resolved, fallbacks: [], reason: "explicit" };
		const available = listAvailableModels().slice(0, 15).join(", ");
		return {
			ok: false,
			query: modelOverride,
			error: `Model "${modelOverride}" not found in registry. Available: ${available}`,
		};
	}

	// 2. Agent frontmatter model — resolve as routing keyword, fuzzy match, or fall through
	let routingKeywordCostPref: CostPreference | undefined;
	if (agentModel) {
		const keyword = parseRoutingKeyword(agentModel);
		if (keyword) {
			// Routing keyword (e.g. "auto-cheap") — skip fuzzy resolution,
			// force auto-routing with the keyword's cost preference
			routingKeywordCostPref = keyword;
		} else {
			const resolved = resolveModelFuzzy(agentModel);
			if (resolved)
				return { ok: true, model: resolved, fallbacks: [], reason: "agent-frontmatter" };
		}
	}

	const effectiveCwd = cwd ?? process.cwd();
	const config = loadRoutingConfig(effectiveCwd);
	const fallback = parentModelId
		? resolveFallback(parentModelId)
		: { provider: "unknown", id: "unknown", displayName: "unknown" };

	// 3. Routing disabled → inherit parent model (unless routing keyword forces auto-routing)
	if (!config.enabled && !routingKeywordCostPref) {
		return { ok: true, model: fallback, fallbacks: [], reason: "fallback" };
	}

	// 4. Auto-route: classify (or use hints), then select ranked candidates
	// Priority: per-call hints > routing keyword > global config
	const effectiveCostPref =
		hints?.costPreference ?? routingKeywordCostPref ?? config.costPreference;
	const hasPerCallCostPreferenceOverride =
		hints?.costPreference !== undefined || routingKeywordCostPref !== undefined;
	const effectiveRoutingMode = hasPerCallCostPreferenceOverride
		? costPreferenceToRoutingMode(effectiveCostPref)
		: config.mode;

	// Build classification — use hints to skip/override classifier where provided
	let classification: ClassificationResult;
	if (hints?.taskType !== undefined && hints?.complexity !== undefined) {
		// Both overridden — skip classifier entirely
		classification = {
			type: hints.taskType,
			complexity: Math.max(1, Math.min(5, hints.complexity)) as ClassificationResult["complexity"],
			reasoning: "per-call hints (type + complexity)",
		};
	} else {
		// Run classifier, then overlay any partial hints
		classification = await classifyTask(task, config.primaryType, agentRole);
		if (hints?.taskType !== undefined) {
			classification = {
				...classification,
				type: hints.taskType,
				reasoning: "per-call hint (type)",
			};
		}
		if (hints?.complexity !== undefined) {
			classification = {
				...classification,
				complexity: Math.max(
					1,
					Math.min(5, hints.complexity)
				) as ClassificationResult["complexity"],
				reasoning: "per-call hint (complexity)",
			};
		}
	}

	// Resolve model scope — constrains candidate pool to a model family
	const scopePool = hints?.modelScope ? resolveModelCandidates(hints.modelScope) : undefined;

	// Detect subscription providers for preferential tiebreaking
	const preferredProviders = getSubscriptionProviders();

	const matrixOverrides = loadMatrixOverrides(effectiveCwd, config);
	const routingModePolicyOverride = config.modePolicyOverrides?.[config.mode];
	const routingSignals = loadRoutingSignalsSnapshot(effectiveCwd, config);

	const selectionOptions: SelectionOptionsWithRouting = {
		matrixOverrides,
		pool: scopePool,
		preferredProviders: preferredProviders.length > 0 ? preferredProviders : undefined,
		routingMode: effectiveRoutingMode,
		routingModePolicyOverride,
		routingSignals,
	};

	const ranked = selectModels(
		classification,
		effectiveCostPref,
		selectionOptions as SelectionOptions
	);
	if (ranked.length > 0) {
		return {
			ok: true,
			model: ranked[0],
			fallbacks: ranked.slice(1),
			reason: scopePool ? "scoped-auto-routed" : "auto-routed",
			classification,
		};
	}

	// 5. No candidates matched → fallback to parent model (or best from scope)
	if (scopePool && scopePool.length > 0) {
		// Scope had models but none met the complexity bar — use the best from scope
		return {
			ok: true,
			model: scopePool[0],
			fallbacks: scopePool.slice(1),
			reason: "scoped-auto-routed",
			classification,
		};
	}
	return { ok: true, model: fallback, fallbacks: [], reason: "fallback", classification };
}
