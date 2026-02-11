# Session Memory Roadmap

## Current

FTS5 full-text search with porter stemming. Exact keyword
matching only — no semantic understanding. Curator LLM
(Haiku) gates results by intent.

## Planned

### Semantic search via local embeddings

Complement FTS5 with vector similarity so conceptual matches
work (e.g. "UI wireframe" finds "ASCII mockup").

- **Model**: `nomic-embed-text` via MLX (Apple Silicon)
- **Storage**: `sqlite-vec` extension in the same index.db
- **Scoring**: hybrid — FTS5 rank + cosine similarity
- **Fully local**: no network calls, no API keys
- **Cross-platform**: future support via `transformers.js`
  (ONNX/WASM in Node.js) for non-Mac users

### Pinned memories with decay

Explicit high-priority memories stored separately from
session recall. Few and strong beats many and weak.

#### Storage

Same `index.db`, separate `memories` table:

- `content` — the thing to remember
- `project` — scoped to project, or NULL for global
- `strength` — decays over time, boosted on recall
- `pinned` — boolean, disables decay (permanent)
- `times_recalled` — how often it's been surfaced
- `last_recalled_at` — timestamp of last recall
- `created_at` — timestamp
- `embedding` — vector (when semantic search lands)

#### Strength model

```
strength = base * decay(age) + recall_boost(times_recalled, last_recalled)
```

- **Decay by default** — memories fade over weeks
  unless recalled or pinned
- **Recall strengthens** — every time a memory is
  surfaced and useful, its strength increases
- **Pin to preserve** — explicit "this is permanent"
  disables decay entirely
- **Hard cap** — ~50 active memories per project,
  weakest get evicted

#### Tools

- `remember` — store a memory (only when explicitly
  asked, high threshold)
- `session_recall` — also searches memories table,
  memories ranked above session matches

#### Principles

- Less is better — fewer strong memories over many
  weak ones reduces context poisoning
- Decay is the default — most things should disappear
- Relevance is proven by use, not by declaration
