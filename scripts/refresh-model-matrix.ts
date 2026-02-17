#!/usr/bin/env bun

/**
 * Refresh MODEL_MATRIX in extensions/subagent-tool/model-matrix.ts
 * from LM Arena leaderboard data.
 *
 * Fetches ELO scores from arena.ai/leaderboard/{code,vision,text},
 * maps Arena model names to tallow model IDs via ARENA_TO_TALLOW,
 * converts ELO → tier (1-5), and generates a diff report.
 *
 * Usage:
 *   bun scripts/refresh-model-matrix.ts           # dry-run (prints diff)
 *   bun scripts/refresh-model-matrix.ts --write    # update the file
 *   bun scripts/refresh-model-matrix.ts --json     # output JSON report
 *
 * @returns Exit 0 on success, 1 on errors, 2 on network failures.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ArenaEntry {
	rank: number;
	name: string;
	elo: number;
	votes: number;
}

interface ModelRatings {
	code?: number;
	vision?: number;
	text?: number;
}

type LeaderboardType = "code" | "vision" | "text";

interface DiffEntry {
	model: string;
	field: LeaderboardType;
	old: number | undefined;
	new: number;
}

// ─── ELO → Tier thresholds ───────────────────────────────────────────────────
// Each leaderboard has a different ELO scale. These thresholds define the
// tier boundaries. Tier 5 = top frontier, tier 1 = entry-level.
//
// Methodology: look at natural clustering breaks in each leaderboard's
// ELO distribution. The top ~5 models get tier 5, next cluster tier 4, etc.

const ELO_THRESHOLDS: Record<LeaderboardType, readonly [number, number, number, number]> = {
	//                       tier5  tier4  tier3  tier2   (below tier2 = tier1)
	code: [1440, 1370, 1280, 1180],
	vision: [1250, 1200, 1150, 1100],
	text: [1460, 1410, 1370, 1320],
};

// ─── Arena name → tallow model ID mapping ─────────────────────────────────────
// Arena uses display names that don't always match pi-ai model IDs.
// This table maps Arena names to the base model IDs in MODEL_MATRIX.
//
// Rules:
// - Only map base models (no -thinking, no -high effort variants)
// - Strip date suffixes (claude-opus-4-5-20251101 → claude-opus-4-5)
// - Some models need explicit mapping when names diverge
// - null = explicitly skip this Arena model (thinking variant, renamed, etc.)

const ARENA_TO_TALLOW: Record<string, string | null> = {
	// ── Anthropic ──────────────────────────────────────────────────
	"claude-opus-4-6": "claude-opus-4-6",
	"claude-opus-4-6-thinking": null, // thinking variant
	"claude-opus-4-5-20251101": "claude-opus-4-5",
	"claude-opus-4-5-20251101-thinking-32k": null, // thinking variant
	"claude-opus-4-1-20250805": "claude-opus-4-1",
	"claude-opus-4-1-20250805-thinking-16k": null, // thinking variant
	"claude-opus-4-20250514": "claude-opus-4", // if present in matrix
	"claude-opus-4-20250514-thinking-16k": null,
	"claude-sonnet-4-5-20250929": "claude-sonnet-4-5",
	"claude-sonnet-4-5-20250929-thinking-32k": null,
	"claude-sonnet-4-20250514": "claude-sonnet-4",
	"claude-sonnet-4-20250514-thinking-32k": null,
	"claude-haiku-4-5-20251001": "claude-haiku-4-5",
	"claude-3-7-sonnet-20250219": "claude-3-7-sonnet",
	"claude-3-7-sonnet-20250219-thinking-32k": null,
	"claude-3-5-sonnet-20241022": "claude-3-5-sonnet",
	"claude-3-5-sonnet-20240620": "claude-3-5-sonnet-v1",
	"claude-3-5-haiku-20241022": "claude-3-5-haiku",
	"claude-3-opus-20240229": "claude-3-opus",
	"claude-3-sonnet-20240229": "claude-3-sonnet",
	"claude-3-haiku-20240307": "claude-3-haiku",

	// ── OpenAI ─────────────────────────────────────────────────────
	"gpt-5.2-high": null, // high-effort variant; use gpt-5.2 base
	"gpt-5.2": "gpt-5.2",
	"gpt-5.1-high": null,
	"gpt-5.1": "gpt-5.1",
	"gpt-5-high": null,
	"gpt-5-chat": "gpt-5",
	"gpt-5-medium": "gpt-5",
	"gpt-5.1-medium": "gpt-5.1",
	"gpt-5-mini-high": null,
	"gpt-5-nano-high": null,
	"gpt-5.2-codex": "gpt-5.2-codex",
	"gpt-5.1-codex": "gpt-5.1-codex",
	"gpt-5.1-codex-mini": "gpt-5.1-codex-mini",
	"gpt-5.3-codex": "gpt-5.3-codex",
	"gpt-5.3-codex-spark": "gpt-5.3-codex-spark",
	"gpt-5.1-codex-max": "gpt-5.1-codex-max",
	"gpt-4.5-preview-2025-02-27": "gpt-4.5",
	"chatgpt-4o-latest-20250326": "chatgpt-4o-latest",
	"gpt-4.1-2025-04-14": "gpt-4.1",
	"gpt-4.1-mini-2025-04-14": "gpt-4.1-mini",
	"gpt-4.1-nano-2025-04-14": "gpt-4.1-nano",
	"gpt-4o-2024-05-13": "gpt-4o",
	"gpt-4o-2024-08-06": "gpt-4o",
	"gpt-4o-mini-2024-07-18": "gpt-4o-mini",
	"gpt-4-turbo-2024-04-09": "gpt-4-turbo",
	"o3-2025-04-16": "o3",
	"o4-mini-2025-04-16": "o4-mini",
	"o3-mini": "o3-mini",
	"o3-mini-high": null,
	"o1-2024-12-17": "o1",
	"o1-mini": "o1-mini",
	"o1-preview": "o1-preview",
	"gpt-oss-120b": null, // open-source GPT variant, not in pi-ai
	"gpt-oss-20b": null,

	// ── Google ─────────────────────────────────────────────────────
	"gemini-3-pro": "gemini-3-pro",
	"gemini-3-flash": "gemini-3-flash",
	"gemini-3-flash (thinking-minimal)": null, // thinking variant
	"gemini-2.5-pro": "gemini-2.5-pro",
	"gemini-2.5-flash": "gemini-2.5-flash",
	"gemini-2.5-flash-preview-09-2025": "gemini-2.5-flash",
	"gemini-2.5-flash-lite-preview-06-17-thinking": null,
	"gemini-2.5-flash-lite-preview-09-2025-no-thinking": null,
	"gemini-2.0-flash-001": "gemini-2.0-flash",
	"gemini-2.0-flash-lite-preview-02-05": "gemini-2.0-flash-lite",
	"gemini-1.5-pro-002": "gemini-1.5-pro",
	"gemini-1.5-pro-001": "gemini-1.5-pro",
	"gemini-1.5-flash-002": "gemini-1.5-flash",
	"gemini-1.5-flash-001": "gemini-1.5-flash",
	"gemini-1.5-flash-8b-001": "gemini-1.5-flash-8b",
	"gemini-advanced-0514": null, // consumer product, not API
	"gemini-pro-dev-api": null, // legacy
	"gemini-pro": null, // legacy
	"gemma-3-27b-it": null, // open model, not in pi-ai registry
	"gemma-3-12b-it": null,
	"gemma-3-4b-it": null,
	"gemma-3n-e4b-it": null,
	"gemma-2-27b-it": null,
	"gemma-2-9b-it": null,
	"gemma-2-9b-it-simpo": null,
	"gemma-2-2b-it": null,
	"gemma-1.1-7b-it": null,
	"gemma-1.1-2b-it": null,
	"gemma-7b-it": null,
	"gemma-2b-it": null,

	// ── Z.ai (Zhipu / GLM) ────────────────────────────────────────
	"glm-5": "glm-5",
	"glm-4.7": "glm-4.7",
	"glm-4.7-flash": null, // not in pi-ai
	"glm-4.6": "glm-4.6",
	"glm-4.6v": null, // vision variant
	"glm-4.5": null, // not in pi-ai
	"glm-4.5-air": null,
	"glm-4.5v": null,
	"glm-4-plus": null,
	"glm-4-plus-0111": null,
	"glm-4-0520": null,

	// ── DeepSeek ──────────────────────────────────────────────────
	"deepseek-v3.2": "deepseek-chat",
	"deepseek-v3.2-exp": null, // experimental
	"deepseek-v3.2-thinking": "deepseek-reasoner",
	"deepseek-v3.2-exp-thinking": null,
	"deepseek-v3.1": null, // older version
	"deepseek-v3.1-thinking": null,
	"deepseek-v3.1-terminus": null,
	"deepseek-v3.1-terminus-thinking": null,
	"deepseek-v3-0324": null,
	"deepseek-v3": null,
	"deepseek-v2.5": null,
	"deepseek-v2.5-1210": null,
	"deepseek-r1": null, // older reasoner
	"deepseek-r1-0528": null,
	"deepseek-coder-v2": null,
	"deepseek-llm-67b-chat": null,

	// ── MiniMax ───────────────────────────────────────────────────
	"minimax-m2.5": "minimax-m2.1", // m2.5 maps to latest minimax in pi-ai
	"minimax-m2.1-preview": "minimax-m2.1",
	"minimax-m2": "minimax-m2",
	"minimax-m1": null, // older

	// ── Moonshot (Kimi) ──────────────────────────────────────────
	"kimi-k2.5-thinking": null, // thinking variant
	"kimi-k2.5-instant": "kimi-k2.5",
	"kimi-k2-thinking-turbo": null, // thinking variant
	"kimi-k2-0905-preview": "kimi-k2",
	"kimi-k2-0711-preview": "kimi-k2",

	// ── Qwen (Alibaba) ──────────────────────────────────────────
	"qwen3-coder-480b-a35b-instruct": "qwen3-coder",
	"qwen3-max-preview": "qwen3-max",
	"qwen3-max-2025-09-23": "qwen3-max",
	"qwen3-235b-a22b-instruct-2507": null, // open weight, not API
	"qwen3-235b-a22b-no-thinking": null,
	"qwen3-235b-a22b-thinking-2507": null,
	"qwen3-235b-a22b": null,
	"qwen3-30b-a3b-instruct-2507": null,
	"qwen3-30b-a3b": null,
	"qwen3-32b": null,
	"qwen3-next-80b-a3b-instruct": null,
	"qwen3-next-80b-a3b-thinking": null,
	"qwen3-vl-235b-a22b-instruct": null,
	"qwen3-vl-235b-a22b-thinking": null,
	"qwq-32b": null,
	"qwq-32b-preview": null,
	"qwen2.5-max": null,
	"qwen2.5-plus-1127": null,
	"qwen2.5-72b-instruct": null,
	"qwen2.5-coder-32b-instruct": null,
	"qwen-plus-0125": null,
	"qwen-max-0919": null,
	"qwen2-72b-instruct": null,

	// ── xAI (Grok) ───────────────────────────────────────────────
	"grok-4.1": "grok-4.1",
	"grok-4.1-thinking": null, // thinking variant
	"grok-4-1-fast-reasoning": "grok-4",
	"grok-4-fast-chat": "grok-4",
	"grok-4-fast-reasoning": "grok-4",
	"grok-4-0709": "grok-4",
	"grok-3-preview-02-24": null, // older
	"grok-3-mini-beta": null,
	"grok-3-mini-high": null,
	"grok-2-2024-08-13": null,
	"grok-2-mini-2024-08-13": null,
	"grok-code-fast-1": null, // code-specific, not in pi-ai

	// ── Mistral ──────────────────────────────────────────────────
	"mistral-large-3": "mistral-large-3",
	"mistral-large-2411": null, // older
	"mistral-large-2407": null,
	"mistral-large-2402": null,
	"mistral-medium-2508": null,
	"mistral-medium-2505": null,
	"mistral-medium": null,
	"mistral-small-2506": null,
	"mistral-small-24b-instruct-2501": null,
	"mistral-small-3.1-24b-instruct-2503": null,
	"magistral-medium-2506": null,
	"devstral-2": "devstral-2",
	"devstral-medium-2507": "devstral-medium",

	// ── Meta (Llama) ─────────────────────────────────────────────
	// Llama models are open-weight and appear under various providers
	// in pi-ai (groq, bedrock, etc.) but aren't base models in our matrix
	"llama-3.1-405b-instruct-bf16": null,
	"llama-3.1-405b-instruct-fp8": null,
	"llama-3.1-70b-instruct": null,
	"llama-3.1-8b-instruct": null,
	"llama-3.3-70b-instruct": null,
	"llama-3-70b-instruct": null,
	"llama-3-8b-instruct": null,
	"llama-4-maverick-17b-128e-instruct": null,
	"llama-4-scout-17b-16e-instruct": null,
	"llama-3.2-3b-instruct": null,
	"llama-3.2-1b-instruct": null,
	"llama-2-70b-chat": null,
	"llama-2-13b-chat": null,
	"llama-2-7b-chat": null,

	// ── Others (not in pi-ai or irrelevant) ──────────────────────
	"dola-seed-2.0-preview": null,
	"ernie-5.0-0110": null,
	"ernie-5.0-preview-1203": null,
	"ernie-5.0-preview-1022": null,
	"ernie-5.0-preview-1103": null,
	"ernie-5.0-preview-1220": null,
	"longcat-flash-chat": null,
	"nova-2-lite": null,
	"amazon-nova-pro-v1.0": null,
	"amazon-nova-lite-v1.0": null,
	"amazon-nova-micro-v1.0": null,
	"amazon-nova-experimental-chat-12-10": null,
	"amazon-nova-experimental-chat-11-10": null,
	"amazon-nova-experimental-chat-10-20": null,
	"amazon-nova-experimental-chat-10-09": null,
	"KAT-Coder-Pro-V1": null,
	"mai-1-preview": null,
	mercury: null,
	"mimo-v2-flash (non-thinking)": null,
	"athene-v2-chat": null,
	"athene-70b-0725": null,
	"olmo-3.1-32b-instruct": null,
	"olmo-3-32b-think": null,
	"olmo-3.1-32b-think": null,
	"olmo-2-0325-32b-instruct": null,
	"olmo-7b-instruct": null,
	"command-a-03-2025": null,
	"command-r-plus-08-2024": null,
	"command-r-plus": null,
	"command-r-08-2024": null,
	"command-r": null,
	"step-3.5-flash": null,
	"step-3": null,
	"step-2-16k-exp-202412": null,
	"step-1o-turbo-202506": null,
	"intellect-3": null,
	"ling-flash-2.0": null,
	"ring-flash-2.0": null,
	"hunyuan-t1-20250711": null,
	"hunyuan-turbos-20250416": null,
	"hunyuan-turbos-20250226": null,
	"hunyuan-turbo-0110": null,
	"hunyuan-large-2025-02-10": null,
	"hunyuan-large-vision": null,
	"hunyuan-standard-2025-02-10": null,
	"hunyuan-standard-256k": null,
	"hunyuan-standard-vision-2024-12-31": null,
	"hunyuan-vision-1.5-thinking": null,
	"ibm-granite-h-small": null,

	// ── Vision-only models (not in pi-ai) ─────────────────────────
	"qwen-vl-max-2025-08-13": null,
	"qwen-vl-max-1119": null,
	"qwen2.5-vl-72b-instruct": null,
	"qwen2.5-vl-32b-instruct": null,
	"qwen2-vl-72b": null,
	"qwen2-vl-7b-instruct": null,
	"step-1o-vision-32k-highres": null,
	"step-1v-32k": null,
	"pixtral-large-2411": null,
	"pixtral-12b-2409": null,
	"molmo-72b-0924": null,
	"molmo-7b-d-0924": null,
	"internvl2-26b": null,
	"internvl2-4b": null,
	"yi-vision": null,
	"c4ai-aya-vision-32b": null,
	"nvila-internal-15b-v1": null,
	"llava-onevision-qwen2-72b-ov": null,
	"llava-v1.6-34b": null,
	"minicpm-v-2_6": null,
	"cogvlm2-llama3-chat-19b": null,
	"phi-3.5-vision-instruct": null,
	"phi-3-vision-128k-instruct": null,
	"llama-3.2-vision-90b-instruct": null,
	"llama-3.2-vision-11b-instruct": null,

	// ── Legacy text-only models (not in pi-ai) ────────────────────
	"llama-3.1-nemotron-ultra-253b-v1": null,
	"nvidia-llama-3.3-nemotron-super-49b-v1.5": null,
	"llama-3.3-nemotron-49b-super-v1": null,
	"nvidia-nemotron-3-nano-30b-a3b-bf16": null,
	"llama-3.1-nemotron-70b-instruct": null,
	"llama-3.1-nemotron-51b-instruct": null,
	"nemotron-4-340b-instruct": null,
	"llama2-70b-steerlm-chat": null,
	"llama-3.1-tulu-3-70b": null,
	"llama-3.1-tulu-3-8b": null,
	"yi-lightning": null,
	"yi-1.5-34b-chat": null,
	"yi-34b-chat": null,
	"gpt-4-0125-preview": null,
	"gpt-4-1106-preview": null,
	"gpt-4-0314": null,
	"gpt-4-0613": null,
	"jamba-1.5-large": null,
	"jamba-1.5-mini": null,
	"reka-core-20240904": null,
	"reka-flash-20240904": null,
	"reka-flash-21b-20240226": null,
	"reka-flash-21b-20240226-online": null,
	"c4ai-aya-expanse-32b": null,
	"c4ai-aya-expanse-8b": null,
	"phi-4": null,
	"phi-3-medium-4k-instruct": null,
	"phi-3-small-8k-instruct": null,
	"phi-3-mini-4k-instruct-june-2024": null,
	"phi-3-mini-128k-instruct": null,
	"phi-3-mini-4k-instruct": null,
	"ministral-8b-2410": null,
	"mixtral-8x22b-instruct-v0.1": null,
	"mixtral-8x7b-instruct-v0.1": null,
	"mistral-7b-instruct-v0.2": null,
	"mistral-7b-instruct": null,
	"qwen1.5-110b-chat": null,
	"qwen1.5-72b-chat": null,
	"qwen1.5-32b-chat": null,
	"qwen1.5-14b-chat": null,
	"qwen1.5-7b-chat": null,
	"qwen1.5-4b-chat": null,
	"qwen-14b-chat": null,
	"dbrx-instruct-preview": null,
	"internlm2_5-20b-chat": null,
	"gpt-3.5-turbo-0125": null,
	"gpt-3.5-turbo-1106": null,

	// ── Very old / open-source models (never in pi-ai) ────────────
	"openchat-3.5-0106": null,
	"openchat-3.5": null,
	"openhermes-2.5-mistral-7b": null,
	"snowflake-arctic-instruct": null,
	"granite-3.1-8b-instruct": null,
	"granite-3.1-2b-instruct": null,
	"granite-3.0-8b-instruct": null,
	"granite-3.0-2b-instruct": null,
	"tulu-2-dpo-70b": null,
	"vicuna-33b": null,
	"vicuna-13b": null,
	"vicuna-7b": null,
	"starling-lm-7b-beta": null,
	"starling-lm-7b-alpha": null,
	"guanaco-33b": null,
	"zephyr-orpo-141b-A35b-v0.1": null,
	"zephyr-7b-beta": null,
	"zephyr-7b-alpha": null,
	"solar-10.7b-instruct-v1.0": null,
	"dolphin-2.2.1-mistral-7b": null,
	"mpt-30b-chat": null,
	"mpt-7b-chat": null,
	"falcon-180b-chat": null,
	"wizardlm-70b": null,
	"wizardlm-13b": null,
	"palm-2": null,
	"codellama-34b-instruct": null,
	"codellama-70b-instruct": null,
	"stripedhyena-nous-7b": null,
	"smollm2-1.7b-instruct": null,
	"nous-hermes-2-mixtral-8x7b-dpo": null,
	"chatglm3-6b": null,
	"chatglm2-6b": null,
	"chatglm-6b": null,
	"RWKV-4-Raven-14B": null,
	"oasst-pythia-12b": null,
	"fastchat-t5-3b": null,
	"dolly-v2-12b": null,
	"llama-13b": null,
	"stablelm-tuned-alpha-7b": null,
	"koala-13b": null,
	"alpaca-13b": null,
	"gpt4all-13b-snoozy": null,
};

// ─── Parsing ──────────────────────────────────────────────────────────────────

/** Shape of a leaderboard entry in Arena's RSC payload. */
interface RscEntry {
	rank: number;
	modelDisplayName: string;
	rating: number;
	votes: number;
	modelOrganization?: string;
}

/**
 * Extract the leaderboard entries array from a Next.js RSC payload.
 * Arena (Next.js) embeds structured data in `self.__next_f.push()` script tags.
 * We find the payload containing `"entries":[...]` and parse the JSON array.
 *
 * @param html - Raw HTML of the leaderboard page
 * @returns Parsed Arena entries, or empty array if extraction fails
 */
function extractEntriesFromRsc(html: string): ArenaEntry[] {
	const payloads = [...html.matchAll(/self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs)];

	for (const p of payloads) {
		const payload = p[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");

		const idx = payload.indexOf('"entries":[');
		if (idx === -1) continue;

		// Find the matching closing bracket for the entries array
		const arrayStart = payload.indexOf("[", idx);
		let depth = 0;
		let arrayEnd = arrayStart;
		for (let i = arrayStart; i < payload.length; i++) {
			if (payload[i] === "[") depth++;
			if (payload[i] === "]") depth--;
			if (depth === 0) {
				arrayEnd = i + 1;
				break;
			}
		}

		try {
			const raw: RscEntry[] = JSON.parse(payload.slice(arrayStart, arrayEnd));
			return raw.map((e) => ({
				rank: e.rank,
				name: e.modelDisplayName,
				elo: Math.round(e.rating),
				votes: e.votes,
			}));
		} catch {
			// try next payload
		}
	}

	return [];
}

// ─── ELO → Tier ──────────────────────────────────────────────────────────────

/**
 * Convert an ELO score to a 1-5 tier for a given leaderboard type.
 *
 * @param elo - Arena ELO score
 * @param type - Leaderboard type (code/vision/text)
 * @returns Tier rating 1-5
 */
function eloToTier(elo: number, type: LeaderboardType): number {
	const [t5, t4, t3, t2] = ELO_THRESHOLDS[type];
	if (elo >= t5) return 5;
	if (elo >= t4) return 4;
	if (elo >= t3) return 3;
	if (elo >= t2) return 2;
	return 1;
}

// ─── Fetching ─────────────────────────────────────────────────────────────────

const LEADERBOARD_URLS: Record<LeaderboardType, string> = {
	code: "https://arena.ai/leaderboard/code",
	vision: "https://arena.ai/leaderboard/vision",
	text: "https://arena.ai/leaderboard/text",
};

/**
 * Fetch and parse a leaderboard page.
 * Extracts structured data from Arena's Next.js RSC payload.
 *
 * @param type - Leaderboard type
 * @returns Parsed entries, or empty array on failure
 */
async function fetchLeaderboard(type: LeaderboardType): Promise<ArenaEntry[]> {
	const url = LEADERBOARD_URLS[type];
	console.error(`  Fetching ${type} leaderboard from ${url}...`);

	try {
		const resp = await fetch(url, {
			headers: {
				"User-Agent": "tallow-model-matrix-refresh/1.0",
				Accept: "text/html",
			},
		});

		if (!resp.ok) {
			console.error(`  ⚠ ${type}: HTTP ${resp.status}`);
			return [];
		}

		const html = await resp.text();
		const entries = extractEntriesFromRsc(html);

		if (entries.length === 0) {
			console.error(`  ⚠ ${type}: page fetched but no entries found in RSC payload`);
		} else {
			console.error(`  ✓ ${type}: ${entries.length} models parsed`);
		}

		return entries;
	} catch (err) {
		console.error(`  ✗ ${type}: ${err instanceof Error ? err.message : err}`);
		return [];
	}
}

// ─── Matrix generation ────────────────────────────────────────────────────────

interface MatrixResult {
	matrix: Record<string, ModelRatings>;
	unmapped: Array<{ name: string; type: LeaderboardType; elo: number; rank: number }>;
	diffs: DiffEntry[];
}

/**
 * Build a new MODEL_MATRIX from Arena leaderboard data.
 *
 * @param currentMatrix - Current MODEL_MATRIX contents
 * @returns New matrix, unmapped models, and diffs
 */
async function buildMatrix(currentMatrix: Record<string, ModelRatings>): Promise<MatrixResult> {
	console.error("Fetching Arena leaderboards...");

	const [codeEntries, visionEntries, textEntries] = await Promise.all([
		fetchLeaderboard("code"),
		fetchLeaderboard("vision"),
		fetchLeaderboard("text"),
	]);

	if (codeEntries.length === 0 && visionEntries.length === 0 && textEntries.length === 0) {
		throw new Error("All leaderboard fetches failed — check network / Arena availability");
	}

	// Build new ratings from Arena data
	const newRatings: Record<string, ModelRatings> = {};
	const unmapped: MatrixResult["unmapped"] = [];

	const processEntries = (entries: ArenaEntry[], type: LeaderboardType) => {
		for (const entry of entries) {
			const tallowId = ARENA_TO_TALLOW[entry.name];

			if (tallowId === undefined) {
				// Unknown model — needs to be added to mapping
				unmapped.push({ name: entry.name, type, elo: entry.elo, rank: entry.rank });
				continue;
			}

			if (tallowId === null) {
				// Explicitly skipped (thinking variant, not in pi-ai, etc.)
				continue;
			}

			// If we already have a rating for this model+type, keep the better one
			// (handles cases where multiple Arena entries map to same tallow ID)
			if (!newRatings[tallowId]) {
				newRatings[tallowId] = {};
			}

			const tier = eloToTier(entry.elo, type);
			const existing = newRatings[tallowId][type];
			if (existing === undefined || tier > existing) {
				newRatings[tallowId][type] = tier;
			}
		}
	};

	processEntries(codeEntries, "code");
	processEntries(visionEntries, "vision");
	processEntries(textEntries, "text");

	// Merge with current matrix:
	// - Update existing models with fresh Arena data
	// - Keep models in current matrix that aren't in Arena (codex models, etc.)
	// - Only add NEW models if they have code ratings (our primary use case)
	//   — vision/text-only entries from Arena don't get auto-added
	const merged: Record<string, ModelRatings> = {};

	// Start with current matrix as base
	for (const [id, ratings] of Object.entries(currentMatrix)) {
		merged[id] = { ...ratings };
	}

	// Apply Arena updates — only to models already in matrix or with code ratings
	for (const [id, ratings] of Object.entries(newRatings)) {
		const isExisting = id in merged;
		const hasCodeRating = ratings.code !== undefined;

		if (!isExisting && !hasCodeRating) {
			// Skip vision/text-only models not already in our matrix
			continue;
		}

		if (!merged[id]) {
			merged[id] = {};
		}
		for (const [type, tier] of Object.entries(ratings) as [LeaderboardType, number][]) {
			merged[id][type] = tier;
		}
	}

	// Compute diffs
	const diffs: DiffEntry[] = [];
	const allIds = new Set([...Object.keys(currentMatrix), ...Object.keys(newRatings)]);

	for (const id of allIds) {
		const oldR = currentMatrix[id] || {};
		const newR = merged[id] || {};

		for (const type of ["code", "vision", "text"] as LeaderboardType[]) {
			const oldVal = oldR[type];
			const newVal = newR[type];

			if (oldVal !== newVal && newVal !== undefined) {
				diffs.push({ model: id, field: type, old: oldVal, new: newVal });
			}
		}
	}

	return { matrix: merged, unmapped, diffs };
}

// ─── File generation ──────────────────────────────────────────────────────────

/**
 * Generate the MODEL_MATRIX TypeScript source code.
 *
 * @param matrix - The matrix data
 * @returns Formatted TypeScript source for the matrix constant
 */
function generateMatrixSource(matrix: Record<string, ModelRatings>): string {
	// Group by vendor for readability
	const groups: Record<string, [string, ModelRatings][]> = {
		Anthropic: [],
		OpenAI: [],
		Google: [],
		"Z.ai (Zhipu)": [],
		DeepSeek: [],
		MiniMax: [],
		"Moonshot (Kimi)": [],
		"Qwen (Alibaba)": [],
		xAI: [],
		Mistral: [],
		Other: [],
	};

	const vendorPrefixes: Record<string, string> = {
		claude: "Anthropic",
		gpt: "OpenAI",
		chatgpt: "OpenAI",
		o1: "OpenAI",
		o3: "OpenAI",
		o4: "OpenAI",
		gemini: "Google",
		glm: "Z.ai (Zhipu)",
		deepseek: "DeepSeek",
		minimax: "MiniMax",
		kimi: "Moonshot (Kimi)",
		qwen: "Qwen (Alibaba)",
		grok: "xAI",
		mistral: "Mistral",
		devstral: "Mistral",
	};

	for (const [id, ratings] of Object.entries(matrix)) {
		const prefix = Object.keys(vendorPrefixes).find((p) => id.startsWith(p));
		const group = prefix ? vendorPrefixes[prefix] : "Other";
		groups[group].push([id, ratings]);
	}

	const lines: string[] = [];

	for (const [vendor, entries] of Object.entries(groups)) {
		if (entries.length === 0) continue;

		lines.push(`\t// ${vendor}`);

		// Sort entries: by name naturally (opus before sonnet, higher versions first)
		entries.sort((a, b) => a[0].localeCompare(b[0]));

		for (const [id, ratings] of entries) {
			const parts: string[] = [];
			if (ratings.code !== undefined) parts.push(`code: ${ratings.code}`);
			if (ratings.vision !== undefined) parts.push(`vision: ${ratings.vision}`);
			if (ratings.text !== undefined) parts.push(`text: ${ratings.text}`);
			lines.push(`\t"${id}": { ${parts.join(", ")} },`);
		}
	}

	return lines.join("\n");
}

/**
 * Read the current model-matrix.ts and replace the MODEL_MATRIX constant.
 *
 * @param matrixPath - Path to model-matrix.ts
 * @param matrix - New matrix data
 * @returns Updated file content
 */
function updateFile(matrixPath: string, matrix: Record<string, ModelRatings>): string {
	const content = readFileSync(matrixPath, "utf-8");

	// Find the matrix constant boundaries
	const startMarker = "export const MODEL_MATRIX: Record<string, ModelRatings> = {";
	const startIdx = content.indexOf(startMarker);
	if (startIdx === -1) {
		throw new Error(`Could not find MODEL_MATRIX constant in ${matrixPath}`);
	}

	// Find the closing }; (matching brace)
	const afterStart = startIdx + startMarker.length;
	let depth = 1;
	let endIdx = afterStart;
	for (let i = afterStart; i < content.length; i++) {
		if (content[i] === "{") depth++;
		if (content[i] === "}") depth--;
		if (depth === 0) {
			endIdx = i + 1; // include the }
			break;
		}
	}

	// Find the semicolon after the closing brace
	const semiIdx = content.indexOf(";", endIdx);
	if (semiIdx === -1 || semiIdx > endIdx + 5) {
		throw new Error("Could not find closing semicolon for MODEL_MATRIX");
	}

	const matrixSource = generateMatrixSource(matrix);
	const today = new Date().toLocaleDateString("en-US", {
		month: "short",
		year: "numeric",
	});

	// Replace the constant (including the header comment)
	const headerComment = `/**
 * Multi-dimensional model capability matrix.
 *
 * Source: Arena leaderboards (arena.ai/leaderboard/*), ${today}.
 * Auto-generated by scripts/refresh-model-matrix.ts — do not edit manually.
 *
 * ELO → tier mapping per leaderboard (each has different ELO scale):
 *   Code:   5=≥${ELO_THRESHOLDS.code[0]}  4=${ELO_THRESHOLDS.code[1]}-${ELO_THRESHOLDS.code[0] - 1}  3=${ELO_THRESHOLDS.code[2]}-${ELO_THRESHOLDS.code[1] - 1}  2=${ELO_THRESHOLDS.code[3]}-${ELO_THRESHOLDS.code[2] - 1}  1=<${ELO_THRESHOLDS.code[3]}
 *   Vision: 5=≥${ELO_THRESHOLDS.vision[0]}  4=${ELO_THRESHOLDS.vision[1]}-${ELO_THRESHOLDS.vision[0] - 1}  3=${ELO_THRESHOLDS.vision[2]}-${ELO_THRESHOLDS.vision[1] - 1}  2=${ELO_THRESHOLDS.vision[3]}-${ELO_THRESHOLDS.vision[2] - 1}  1=<${ELO_THRESHOLDS.vision[3]}
 *   Text:   5=≥${ELO_THRESHOLDS.text[0]}  4=${ELO_THRESHOLDS.text[1]}-${ELO_THRESHOLDS.text[0] - 1}  3=${ELO_THRESHOLDS.text[2]}-${ELO_THRESHOLDS.text[1] - 1}  2=${ELO_THRESHOLDS.text[3]}-${ELO_THRESHOLDS.text[2] - 1}  1=<${ELO_THRESHOLDS.text[3]}
 *
 * Ratings use base model scores — no thinking, default effort.
 */`;

	// Find the JSDoc comment before the constant
	const commentStart = content.lastIndexOf("/**", startIdx);
	if (commentStart === -1 || startIdx - commentStart > 500) {
		throw new Error("Could not find JSDoc comment before MODEL_MATRIX");
	}

	const before = content.slice(0, commentStart);
	const after = content.slice(semiIdx + 1);

	return `${before}${headerComment}\n${startMarker}\n${matrixSource}\n};${after}`;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "..");
const MATRIX_PATH = resolve(ROOT, "extensions", "subagent-tool", "model-matrix.ts");

const args = process.argv.slice(2);
const writeMode = args.includes("--write");
const jsonMode = args.includes("--json");

// Parse current matrix from source (eval-free: regex extract)
function parseCurrentMatrix(): Record<string, ModelRatings> {
	const content = readFileSync(MATRIX_PATH, "utf-8");
	const result: Record<string, ModelRatings> = {};

	// Match lines like: "model-id": { code: 5, vision: 3, text: 5 },
	const lineRe = /^\s*"([^"]+)":\s*\{([^}]*)\}/gm;
	let match: RegExpExecArray | null = lineRe.exec(content);
	while (match !== null) {
		const id = match[1];
		const body = match[2];
		const ratings: ModelRatings = {};

		const codeM = body.match(/code:\s*(\d)/);
		const visionM = body.match(/vision:\s*(\d)/);
		const textM = body.match(/text:\s*(\d)/);

		if (codeM) ratings.code = parseInt(codeM[1], 10);
		if (visionM) ratings.vision = parseInt(visionM[1], 10);
		if (textM) ratings.text = parseInt(textM[1], 10);

		result[id] = ratings;
		match = lineRe.exec(content);
	}

	return result;
}

async function main() {
	console.error("refresh-model-matrix: starting...\n");

	const currentMatrix = parseCurrentMatrix();
	console.error(`Current matrix: ${Object.keys(currentMatrix).length} models\n`);

	const { matrix, unmapped, diffs } = await buildMatrix(currentMatrix);

	if (jsonMode) {
		console.log(JSON.stringify({ matrix, unmapped, diffs }, null, 2));
		return;
	}

	// Print report
	console.error("\n── Report ──────────────────────────────────────────\n");

	if (diffs.length === 0) {
		console.error("No changes detected. Matrix is up to date.\n");
	} else {
		console.error(`Changes (${diffs.length}):`);
		for (const d of diffs) {
			const oldStr = d.old !== undefined ? String(d.old) : "—";
			const arrow = d.old !== undefined ? "→" : "+";
			console.error(`  ${d.model}.${d.field}: ${oldStr} ${arrow} ${d.new}`);
		}
		console.error();
	}

	if (unmapped.length > 0) {
		console.error(`Unmapped Arena models (${unmapped.length}) — add to ARENA_TO_TALLOW mapping:`);
		for (const u of unmapped) {
			console.error(`  ${u.type} #${u.rank}: "${u.name}" (ELO ${u.elo})`);
		}
		console.error();
	}

	const newModels = Object.keys(matrix).filter((id) => !currentMatrix[id]);
	if (newModels.length > 0) {
		console.error(`New models added: ${newModels.join(", ")}\n`);
	}

	const totalModels = Object.keys(matrix).length;
	console.error(`Total models in matrix: ${totalModels}\n`);

	if (writeMode) {
		const updated = updateFile(MATRIX_PATH, matrix);
		writeFileSync(MATRIX_PATH, updated);
		console.error(`✓ Written to ${MATRIX_PATH}`);
	} else {
		console.error("Dry run — use --write to update the file.");
	}
}

main().catch((err) => {
	console.error(`\n✗ Fatal: ${err instanceof Error ? err.message : err}`);
	process.exit(err instanceof Error && err.message.includes("network") ? 2 : 1);
});
