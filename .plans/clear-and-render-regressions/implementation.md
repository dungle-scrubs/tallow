# Clear and Render Regressions — Implementation Plan

## ⚠️ Execution Protocol

A progress report exists at
`.plans/clear-and-render-regressions/progress-report.md`. It lists every
user-facing and operator-facing regression target as a checkbox.

**Mandatory rules for all agents working on this plan:**

1. Before starting a milestone, read its section in the progress report.
2. Check each box as the feature lands, not at the end.
3. A milestone is not done until every checkbox under it is checked.
4. If a missing regression case is discovered, add it before coding.
5. Never declare a phase complete without updating the Summary.

## Architecture

<!-- D-001 --> `/clear` and `/new` MUST behave as a reset transaction,
not as a best-effort pile of side effects. A reset transaction owns four
responsibilities: cancel deferred turn starters, clear previous-session
UI state, rebuild the new session view exactly once, and leave the
editor idle until the user explicitly submits a new prompt.

<!-- D-002 --> Deferred turn starters MUST be tracked by ownership and
must be cancelled on `session_before_switch`, `session_shutdown`, and
any other reset boundary. The initial suspect set is:

- `extensions/context-fork/index.ts` async fork completion
- `extensions/slash-command-bridge/index.ts` compaction continuation
- any future extension path that calls `pi.sendMessage(...,
  { triggerTurn: true })` after a timer, promise, or subprocess

<!-- D-003 --> Render recovery MUST move from ad hoc forced redraws to a
single reset-aware render contract. The current mix of
`requestRender(true)`, `requestScrollbackClear()`, startup grace, and
first-render shortcuts is internally inconsistent. The replacement must
make one boundary authoritative: a reset-aware full render that can
clear stale viewport state and optionally clear scrollback without
replaying transcript history multiple times.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| `packages/tallow-tui` is a fork with conflict surface | Keep TUI changes minimal and isolated |
| `InteractiveMode` is upstream-owned JS in `node_modules` | Prefer tallow patch layer over broad upstream edits |
| Extension async work survives beyond a single handler | Reset must explicitly cancel or ignore late completions |
| `/clear` is a user trust boundary | New session must never inherit hidden work from the old session |

### Boundaries

<!-- D-004 --> Responsibility-first seams will be introduced before more
bug fixes pile into the same files.

1. `src/interactive-mode-patch.ts`
   - Owns integration with upstream `InteractiveMode`
   - Should delegate reset orchestration to a focused helper instead of
     embedding reset, loader, and redraw policy inline
2. `src/workspace-transition-interactive.ts`
   - Owns cross-session swap behavior
   - Should reuse the same reset transaction helper as `/clear` where
     possible, rather than maintaining a parallel reset path
3. `packages/tallow-tui/src/tui.ts`
   - Owns terminal render semantics only
   - Must not encode product-specific reset policy beyond explicit
     reset-aware render primitives
4. `extensions/*`
   - Own extension-local deferred work
   - Must register cancellable deferred turn starters instead of firing
     hidden prompts after reset boundaries

Where new files are created, add short module comments describing what
those files own and what they do not own.

### Observability

<!-- D-005 --> Reset and deferred-turn behavior require first-class
observability. The implementation will add a small structured debug path
for reset lifecycle events and deferred trigger cancellation outcomes.
At minimum:

- reset start / reset complete markers with reason (`clear`, `new`,
  `resume`, `workspace-transition`)
- deferred trigger registration and cancellation counters
- test-visible evidence that no deferred trigger survives a reset
- an end-to-end transcript fixture proving a reset does not auto-start
  a turn and does not replay stale transcript output

---

## Phases

### Phase 1: Reset semantics and leak containment (Days 1-2)

**Goal:** `/clear` produces a quiet idle session and no old async work can
start a new turn afterward.

**Gate from previous:** none

#### M1: Pin leaked prompt sources with failing tests

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add an integration test that reproduces `/clear` starting a
     deferred prompt from a prior session.
  2. GREEN: Prove which deferred trigger source caused the restart
     (`context-fork`, compaction continuation, or another path).
  3. RED: Add a second integration test asserting `/clear` leaves the
     new session idle with no queued hidden prompt.
  4. GREEN: Introduce the minimal cancellation or generation-guard
     needed to keep old-session work from crossing the boundary.
  5. REFACTOR: Extract a shared deferred-trigger registry or reset guard
     API with clear ownership semantics.

#### M2: Centralize reset transaction behavior

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests covering `/clear` and workspace/session swaps using
     the same reset invariants.
  2. GREEN: Route `/clear`, `/new`, and interactive session swaps
     through one reset helper that clears UI, pending visual state, and
     deferred turn ownership exactly once.
  3. RED: Add a regression test that a reset during compaction or forked
     work does not resurrect old loader or status text.
  4. GREEN: Cancel or neuter late completions at the reset boundary.
  5. REFACTOR: Remove duplicated reset steps split between
     `interactive-mode-patch` and workspace transition code.

### Gate 1→2

- [ ] `/clear` never starts a turn without fresh user input
- [ ] deferred trigger tests pass for every known source
- [ ] workspace transition and `/clear` share one reset invariant set

### Phase 2: Render contract and screen clearing (Days 2-4)

**Goal:** reset renders become deterministic, non-replaying, and leave no
stale bottom-of-screen artifacts.

**Gate from previous:** Phase 1 gates pass

#### M3: Remove transcript replay caused by forced redraw spam

- **Dependencies:** M2
- **Effort:** L
- **Tasks:**
  1. RED: Add TUI or interactive-mode tests proving `agent_end` and
     `getUserInput` do not force full transcript repaint on every turn.
  2. GREEN: Replace unconditional `requestRender(true)` calls with a
     reset-aware render path and narrower stale-loader cleanup.
  3. RED: Add a regression test for transcript stability during rapid
     streaming end states.
  4. GREEN: Batch reset-related renders so reset rebuild happens once,
     not as a cascade of full invalidations.
  5. REFACTOR: Separate loader cleanup policy from transcript redraw
     policy.

#### M4: Make reset screen clearing actually clear the old viewport

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: Add a TUI regression test proving a reset followed by the next
     render clears stale bottom-of-screen artifacts.
  2. GREEN: Introduce an explicit reset render primitive or flag so the
     first render after reset can honor scrollback/screen clearing
     instead of falling through `fullRender(false)`.
  3. RED: Add a regression test for startup-grace behavior so flicker
     fixes do not reintroduce stale transcript remnants.
  4. GREEN: Align startup grace, forced invalidation, and scrollback
     semantics under the new reset render contract.
  5. REFACTOR: Shrink or remove now-obsolete workaround logic from
     `render-stabilizer` and related patches if covered by the new
     contract.

### Gate 2→3

- [ ] no replay of the full transcript on idle turn boundaries
- [ ] no stale content remains below the active UI after reset
- [ ] reset render tests pass in both forced and first-render paths

### Phase 3: Proof, observability, and cleanup (Days 4-5)

**Goal:** the fix is measurable, reviewable, and protected by end-to-end
coverage.

**Gate from previous:** Phase 2 gates pass

#### M5: Add reset observability and failure forensics

- **Dependencies:** M4
- **Effort:** M
- **Tasks:**
  1. RED: Add tests asserting reset lifecycle diagnostics are emitted for
     registration, cancellation, and late-drop behavior.
  2. GREEN: Implement structured reset/deferred-trigger diagnostics that
     can be inspected in tests or debug mode.
  3. RED: Add a failure-path test showing a cancelled deferred trigger is
     observable and does not silently restart work.
  4. GREEN: Surface deterministic evidence without noisy user-facing
     spam in normal mode.
  5. REFACTOR: Document the reset contract in module comments and test
     helpers.

#### M6: Run the full confidence suite and remove stale assumptions

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add a dedicated end-to-end transcript fixture for `/clear`
     covering idle reset, no replay, and no bottom ghosting.
  2. GREEN: Make the fixture pass in headless and normal interactive
     execution.
  3. RED: Add coverage for mixed flows: `/clear` during compaction,
     during context-fork completion, and after ordinary turns.
  4. GREEN: Make the full targeted suite pass, then run build,
     typecheck, extension typecheck, lint, and the relevant e2e suite.
  5. REFACTOR: Remove dead guards or redundant redraw workarounds proven
     unnecessary by the new tests.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Hidden async trigger source is missed | high | medium | enumerate every `triggerTurn: true` path and add a shared registry | agent |
| TUI fix solves ghosting but reintroduces flicker | high | medium | add explicit first-render vs reset-render tests | agent |
| Upstream `InteractiveMode` patch drift breaks assumptions | medium | medium | keep changes in tallow patch layer and add invariant tests | agent |
| Reset batching masks genuine loader cleanup bug | medium | low | split loader cleanup tests from transcript repaint tests | agent |

---

## Escape Hatches

1. **If reset batching is too invasive:** keep the current patch layer,
   but add a dedicated `requestResetRender()` primitive in the TUI and
   route only reset boundaries through it.
2. **If shared deferred-trigger registry is too broad initially:** land a
   generation-token guard first, then migrate extensions to explicit
   registration in a follow-up milestone.
3. **If `render-stabilizer` cannot be removed safely:** keep it, but
   narrow it to selector/layout transitions only and document why.

---

## Validation Commands

```bash
bun test extensions/clear
bun test extensions/slash-command-bridge
bun test extensions/context-fork
bun test src/__tests__/interactive-mode-patch.test.ts
bun test src/__tests__/workspace-transition-interactive.test.ts
bun test packages/tallow-tui/src/__tests__/tui-diff-regression.test.ts
bun test extensions/__integration__/lifecycle.test.ts
bun test extensions/__integration__/slash-command-bridge.test.ts
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
(`.plans/clear-and-render-regressions/plan.db`). Query with:

```bash
node /Users/kevin/dev/skills/planner/scripts/plan-db.ts query-decisions \
  --plan "clear-and-render-regressions"
```

Key decisions referenced in this document use `<!-- D-NNN -->` markers.
