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

### Pinned memories with decay — backed by hippo

Use `hippo` (`~/dev/hippo`) as the memory backend instead
of a bespoke `memories` table. Hippo already implements
the full lifecycle: fact extraction, conflict resolution
(DUPLICATE/SUPERSEDES/DISTINCT), strength decay, encounter
tracking, content-hash dedup, and agent-scoped storage.

#### Integration

- Import hippo as a library (in-process, no network hop)
- Hippo provides the structured memory layer; session
  recall stays as the conversation search layer
- `agentId` maps to tallow project name
- Hippo's `remember_facts` replaces the planned
  `remember` tool — it extracts structured facts from
  free text and resolves conflicts with existing memory
- Hippo's `recall_memories` supplements session search —
  memories ranked above session matches
- Hippo's memory blocks (`store_memory`) can hold
  per-project persona, objectives, learned preferences

#### Why hippo over a custom table

- Conflict resolution already works (supersession chains,
  duplicate detection via LLM classification)
- Strength/decay model already implemented and tested
- Content-hash dedup prevents storing the same memory twice
- Input validation, atomicity (transaction-wrapped
  supersession), and agent isolation already hardened
- Avoids reimplementing the same primitives inside tallow

#### Principles (unchanged)

- Less is better — fewer strong memories over many
  weak ones reduces context poisoning
- Decay is the default — most things should disappear
- Relevance is proven by use, not by declaration

### Not using QMD for session search

Evaluated QMD (`github.com/tobi/qmd`) — local hybrid
search (BM25 + vector + LLM reranking). Strong retrieval
quality, but wrong fit for session memory:

- **Data format mismatch**: sessions are JSONL with
  structured events, not markdown files. Would need a
  continuous conversion pipeline.
- **Loses turn structure**: QMD chunks by markdown
  headings/paragraphs. The ±1 context turn around matches
  and user/assistant pairing would vanish.
- **Loses the curator**: the `looking_for` parameter
  lets the curator extract specifically what's needed from
  noisy conversation. QMD's reranker scores relevance but
  doesn't reshape output.
- **Heavy dependency**: node-llama-cpp + ~2GB of GGUF
  models. Session memory is currently zero-dep (just
  SQLite FTS5).

QMD is better suited for indexing document corpora (notes,
docs, knowledge bases) — not agent conversation transcripts.
The right path is adding vector search directly to the
session indexer (see semantic search section above).
