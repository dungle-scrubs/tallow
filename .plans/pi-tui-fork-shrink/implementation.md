# pi-tui Fork Shrink — Implementation Plan

## ⚠️ Execution Protocol

A progress report exists at `.plans/pi-tui-fork-shrink/progress-report.md`.
It is the canonical source of truth for what is complete and what
remains.

**Mandatory rules for all agents working on this plan:**

1. Read the progress report before touching a milestone.
2. Check each feature box as it lands, not at the end.
3. Do not mark a milestone complete until every feature under it is
   checked.
4. If a hidden dependency appears, add it to the report before
   implementing.
5. Re-run convergence checks whenever the living plan artifacts change.

## Architecture

<!-- D-001 --> `packages/tallow-tui` MUST move back to a narrow product
primitive fork rather than a broad rendering subsystem. The long-term
fork surface should be limited to only those APIs that tallow still
clearly requires and cannot obtain from upstream or application-level
helpers.

<!-- D-002 --> The target long-term keep surface is:

- border styles
- loader global defaults and hide sentinel
- editor ghost-text and change-listener APIs
- the smallest possible reset/render primitive surface if upstream still
  lacks it

Everything else starts as revert-or-extract unless proven necessary.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| `packages/tallow-tui` is a local workspace package, not a separately tracked upstream mirror | Sync discipline must be explicit, not assumed |
| Resume/reset behavior is currently unstable | PTY regressions must gate all high-risk TUI changes |
| Tallow runtime patches already own some session semantics | app-specific reset behavior should move out of the fork, not deeper into it |
| Some local APIs are already consumed by extensions | reduction must preserve real callers before reverting files |

### Boundaries

<!-- D-003 --> Ownership boundaries after the reduction should be:

1. `packages/tallow-tui`
   - owns generic TUI primitives only
   - does not own tallow session policy
2. `src/interactive-*.ts`
   - owns tallow session/reset/rebuild behavior
   - may consume narrow TUI primitives, but should not require a custom
     rendering engine fork
3. `extensions/*`
   - own product features and UI composition
   - should depend on stable exported APIs rather than undocumented fork
     behavior

### Observability

<!-- D-004 --> Fork reduction touches runtime and interactive failure
modes, so observability is mandatory. The implementation must preserve
PTY regressions for transcript replay, stale reset output, and ghost
input paths. Validation reports must make it clear which file re-sync
pass introduced any regression.

---

## Phases

### Phase 1: Baseline and fork truth (Days 1-2)

**Goal:** establish an accurate, reviewable inventory of what the fork is
and why each remaining delta exists.

**Gate from previous:** none

#### M1: Rewrite stale fork documentation

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a documentation drift check or targeted assertion proving
     the current fork README no longer matches reality.
  2. GREEN: Update `packages/tallow-tui/README.md` and any other fork
     surface docs to reflect current upstream version and actual delta.
  3. RED: Add a test or script assertion that the documented keep set is
     internally consistent with exported APIs.
  4. GREEN: Make the doc assertions pass.
  5. REFACTOR: Remove obsolete language about now-upstream features such
     as input middleware.

#### M2: Produce authoritative delta inventory

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add a reproducible audit script or report test that detects all
     local-vs-upstream runtime file deltas.
  2. GREEN: Generate the canonical file list and classify each delta as
     keep, extract, upstream, or revert.
  3. RED: Add a regression assertion for the known must-keep API set.
  4. GREEN: Lock those API expectations in tests/docs.
  5. REFACTOR: Move one-off audit logic into a maintainable script or
     checklist artifact.

### Gate 1→2

- [ ] Fork docs match current upstream reality
- [ ] Delta inventory exists and classifies every changed runtime file
- [ ] Must-keep API set is explicitly recorded and test-backed

### Phase 2: Low-risk upstream re-sync (Days 2-4)

**Goal:** remove obviously unjustified drift first while preserving current
product behavior.

**Gate from previous:** Phase 1 gates pass

#### M3: Re-sync low-risk files to upstream

- **Dependencies:** M2
- **Effort:** L
- **Tasks:**
  1. RED: Add targeted tests around markdown, text, stdin buffering,
     input, and autocomplete behavior where current tallow depends on
     them.
  2. GREEN: Revert low-risk files to upstream latest where no justified
     local dependency remains.
  3. RED: Add regression coverage for any low-risk file that fails after
     sync and needs temporary protection.
  4. GREEN: Restore only the minimum needed behavior, not the whole old
     diff.
  5. REFACTOR: Remove dead compatibility code left behind by re-sync.

#### M4: Re-sync selector and keybinding drift

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: Add targeted tests for select list, settings list, and keyboard
     handling that capture real tallow expectations instead of historical
     local quirks.
  2. GREEN: Revert unjustified list/keybinding/key parsing drift to
     upstream latest.
  3. RED: Add focused tests for any key or selector hook that remains a
     real tallow dependency.
  4. GREEN: Keep only the minimal surviving local hooks.
  5. REFACTOR: Simplify local keybinding shims after re-sync.

### Gate 2→3

- [ ] low-risk files are aligned with upstream or explicitly justified
- [ ] selector and keybinding drift is reduced to test-backed deltas
- [ ] no regressions in PTY resume/reset or extension UX

### Phase 3: Extract tallow-owned behavior (Days 4-6)

**Goal:** move app-specific helpers out of the fork so fewer local deltas
need to remain.

**Gate from previous:** Phase 2 gates pass

#### M5: Extract app-level helpers from the fork

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add tests around link helpers, image metadata helpers, and
     image file-path injection at the tallow layer.
  2. GREEN: Move app-specific utilities out of `packages/tallow-tui`
     into tallow/shared code where appropriate.
  3. RED: Add tests confirming extension consumers still work through the
     new shared surface.
  4. GREEN: Remove the corresponding fork-local ownership.
  5. REFACTOR: Clean exports so `packages/tallow-tui/index.ts` only
     exposes surviving true TUI primitives.

#### M6: Preserve only justified local primitives

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add targeted tests for border styles, loader defaults/hide,
     editor ghost-text APIs, and any surviving reset primitive.
  2. GREEN: Reduce local files to the smallest set needed for those
     primitives.
  3. RED: Add tests proving removed local files are no longer needed by
     extensions or runtime code.
  4. GREEN: Delete or fully re-sync the no-longer-needed local pieces.
  5. REFACTOR: Update exports and docs to match the reduced primitive
     set.

### Gate 3→4

- [ ] application-specific helpers no longer live in the fork
- [ ] remaining local primitives are small, explicit, and test-backed
- [ ] runtime imports no longer rely on accidental fork behavior

### Phase 4: High-risk render/input shrink and final validation (Days 6-9)

**Goal:** shrink the dangerous render/reset/input deltas without rebreaking
resume, `/clear`, or typing behavior.

**Gate from previous:** Phase 3 gates pass

#### M7: Shrink `tui.ts`, `terminal.ts`, and reset-related drift

- **Dependencies:** M6
- **Effort:** XL
- **Tasks:**
  1. RED: Keep PTY regressions for resume transcript replay, stale reset
     output, and ghost input in place before touching high-risk files.
  2. GREEN: Re-sync `tui.ts` and `terminal.ts` toward upstream, keeping
     only the explicit primitives tallow still requires.
  3. RED: Add focused tests for any surviving render-batch,
     scrollback-clear, or grace-reset primitives.
  4. GREEN: Make the narrowed primitive surface pass without transcript
     reprint or injected input regressions.
  5. REFACTOR: Remove remaining workaround extensions or patch glue that
     became obsolete after the shrink.

#### M8: Final fork delta verification

- **Dependencies:** M7
- **Effort:** M
- **Tasks:**
  1. RED: Add or update an audit script assertion that the remaining fork
     delta matches the documented keep set exactly.
  2. GREEN: Make the audit pass against latest upstream reference.
  3. RED: Run the full validation suite and treat any failure as a plan
     blocker.
  4. GREEN: Achieve clean `bun test`, typechecks, lint, fork build,
     root build, and slash-command e2e.
  5. REFACTOR: Archive superseded audit notes and leave one canonical
     fork status document.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| A supposedly low-risk upstream sync breaks hidden extension behavior | high | medium | add targeted tests before each file re-sync | agent |
| PTY resume/reset bugs return during `tui.ts` shrink | high | medium | keep PTY regression tests mandatory through Phase 4 | agent |
| Useful generic improvements get stranded locally | medium | medium | classify upstream-worthy changes explicitly instead of silently keeping them | agent |
| Documentation drifts again after the shrink | medium | medium | add audit/docs assertions and keep one canonical fork status doc | agent |

---

## Escape Hatches

1. **If a revert breaks a real tallow behavior:** restore only the
   smallest API surface needed, not the entire old file.
2. **If upstream lacks a required primitive:** keep it locally, but mark
   it explicitly as a long-term keep or upstream candidate.
3. **If `tui.ts` shrink is too risky in one pass:** keep a minimal reset
   primitive layer and defer the rest behind PTY coverage.

---

## Validation Commands

```bash
bun test
bun test src/__tests__/interactive-clear-path.test.ts
bun test src/__tests__/interactive-mode-patch.test.ts
bun run typecheck
bun run typecheck:extensions
bun run lint
cd packages/tallow-tui && bun run build
cd ../.. && bun run build
node tests/e2e-commands.mjs
```

---

## Decisions

Canonical decisions are in the plan database
(`.plans/pi-tui-fork-shrink/plan.db`). Query with:

```bash
node /Users/kevin/dev/skills/planner/scripts/plan-db.ts query-decisions \
  --plan "pi-tui-fork-shrink"
```

Key decisions referenced in this document use `<!-- D-NNN -->` markers.
