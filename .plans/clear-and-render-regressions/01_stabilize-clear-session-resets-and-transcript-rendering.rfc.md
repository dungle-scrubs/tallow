---
number: 01
title: "Stabilize /clear session resets and transcript rendering"
type: refactor
status: Draft
author: Kevin Frilot
date: 2026-04-18
---

# RFC-01: Stabilize /clear session resets and transcript rendering

## Abstract

<!-- D-001 --> Tallow's session reset behavior is currently split across
interactive-mode patches, workspace transition code, extension-local
async work, and TUI redraw heuristics. The result is user-visible
breakage: `/clear` can inherit deferred work from a prior session,
transcript content can be replayed or jump during redraw, and stale UI
artifacts can remain below the active viewport after a reset. This RFC
proposes a single reset transaction, explicit ownership of deferred turn
starters, and a reset-aware render contract in the TUI. The refactor is
intended to restore one invariant: after `/clear`, the product is quiet,
idle, and visually clean until the user asks for more.

## Introduction

The current behavior is bad.

A command that users read as "clear this session and let me start over"
currently behaves more like "construct a new session while several old
subsystems keep talking." That makes `/clear` unsafe as a recovery tool.
When the user reaches for it, the system can immediately restart hidden
work, replay large chunks of transcript output, or leave stale startup
content at the bottom of the screen.

This RFC covers:

- `/clear` and `/new` reset semantics in interactive mode
- session-boundary handling for deferred prompts and async completions
- TUI render behavior for reset, first render, and scrollback clearing
- regression-proof testing and observability for these paths

This RFC does not cover:

- redesigning normal non-reset transcript rendering
- changing user-facing `/clear` copy or slash-command ergonomics
- background-task result UX outside reset-boundary safety fixes

## Terminology

The key words "MUST", "MUST NOT", "SHOULD", and "MAY" in this document
are to be interpreted as described in RFC 2119.

- **Reset transaction**: the complete operation that tears down the old
  interactive session state, creates the new session, rebuilds the UI,
  and returns the editor to an idle state.
- **Deferred turn starter**: any timer, promise, subprocess completion,
  or queued callback that can call `sendMessage(..., { triggerTurn:
  true })` after the originating handler returns.
- **Reset-aware render**: a render path that knows the current frame is
  the first frame after a session reset and therefore applies stronger
  clearing semantics than an ordinary incremental redraw.
- **Late completion**: async work that resolves after its originating
  session has already been replaced.

## Current State

<!-- D-002 --> The regression did not land in one commit. It accreted.
The likely timeline is:

1. `extensions/context-fork/index.ts` has allowed async fork completion
   to call `pi.sendMessage(..., { triggerTurn: true })` since
   2026-02-12 (`14d082447`) without reset-boundary cancellation.
2. `extensions/slash-command-bridge/index.ts` added timed compaction
   auto-continuation on 2026-02-24 and refined it on 2026-03-14
   (`9776a164`, `e93923e99`). That path does clear on
   `session_before_switch`, but it introduced another deferred-turn
   source that must be reasoned about.
3. TUI scrollback-clearing support landed on 2026-03-17
   (`ecf4559f9`) and session swaps began requesting it the same day
   (`19560f741`). The implementation only consumes the flag inside
   `fullRender(true)`, while first render still uses `fullRender(false)`.
4. Forced `requestRender(true)` calls were added on 2026-03-21 in
   `src/interactive-mode-patch.ts` (`5800f4a8d`, `342d8d50f`) to solve
   stale loader text. Those calls reset render history and make later
   paints behave like fresh full transcript renders.
5. Startup-grace redraw softening landed on 2026-03-31 (`552ab95b`). It
   reduced visible flicker, but it did not fix the underlying reset
   contract mismatch, so the system became harder to reason about and
   the symptom mix got worse over time.

The current system therefore has three overlapping failure classes:

- **Deferred work leakage**: old-session async completions can outlive
  the session boundary and may still inject work.
- **Replay by forced invalidation**: unconditional forced renders wipe
  TUI history and repaint more than necessary.
- **Incomplete clearing**: reset requests can ask for scrollback clear,
  but the next render may bypass the clearing path and leave stale lines
  behind.

## Proposed Changes

<!-- D-003 --> The refactor will introduce one reset contract shared by
`/clear`, `/new`, and interactive session swaps.

### 1. Reset transaction helper

A focused helper SHOULD own reset sequencing. It will:

1. mark the current session generation as closed
2. cancel or invalidate all deferred turn starters owned by that
   session
3. clear visual state once
4. swap to the new session
5. perform one reset-aware render
6. leave the editor idle

### 2. Deferred turn ownership

<!-- D-004 --> Every deferred turn starter MUST be associated with a
session generation or explicit reset token. A late completion MUST NOT
start a turn if its generation no longer matches the active session.

The first migration target list is:

- `extensions/context-fork/index.ts`
- `extensions/slash-command-bridge/index.ts`
- any additional path discovered by searching for
  `triggerTurn: true`

### 3. Reset-aware render primitive

<!-- D-005 --> The TUI MUST expose one explicit way to render the first
frame after reset. That path may clear screen and scrollback, or may use
an equivalent safe primitive, but it must not depend on incidental later
conditions such as width change or shrink-triggered full redraw.

### 4. Narrower loader cleanup

The stale loader problem SHOULD be solved without global forced redraws
on every idle transition. Loader cleanup and transcript repaint are
separate responsibilities and SHOULD be tested separately.

## Migration Strategy

The migration is incremental.

1. Add failing integration tests for leaked deferred prompts.
2. Add failing TUI tests for stale bottom-of-screen artifacts after
   reset.
3. Introduce reset generation or registry primitives without changing
   user-facing behavior.
4. Migrate deferred trigger sources to the new ownership model.
5. Replace unconditional forced redraws with reset-aware render logic.
6. Remove or narrow workaround code that becomes redundant.

No user-facing data migration is required.

## Security Considerations

<!-- D-006 --> `/clear` is a trust boundary between the just-finished
session and the new one. If hidden work from the prior session can run
inside the replacement session, the user loses control of when work
starts and what context it uses. The refactor therefore treats leaked
prompts as a correctness and safety issue, not as a cosmetic UI bug.

## Risk Assessment

Primary risks:

- a missed deferred trigger source keeps the leak alive
- a render fix regresses startup flicker or loader cleanup
- TUI fork changes drift from upstream assumptions

Rollback strategy:

- keep changes small and layered behind tests
- land the deferred-trigger guard before larger render cleanup
- prefer additive reset-aware primitives over broad behavior rewrites

## Testing Strategy

<!-- D-007 --> The fix will be developed with strict RED→GREEN→REFACTOR
ordering and must prove behavior at four levels:

1. unit tests for helper logic and trigger ownership
2. integration tests for `/clear`, compaction, and session swap
   boundaries
3. TUI regression tests for reset render semantics and stale-line
   clearing
4. end-to-end transcript fixtures proving `/clear` does not auto-start a
   new turn, does not replay transcript history, and does not leave
   stale bottom-of-screen content

## Implementation Plan

Implementation details live in:

- `.plans/clear-and-render-regressions/implementation.md`
- `.plans/clear-and-render-regressions/progress-report.md`

The work is organized into three phases:

1. reset semantics and leak containment
2. render contract and screen clearing
3. proof, observability, and cleanup

## Open Questions

At draft time, no product-level open questions remain. The remaining
uncertainty is implementation discovery: which deferred source or
combination of sources is responsible for the observed `/clear` leak in
current interactive runs.

## References

### Normative

- `extensions/context-fork/index.ts`
- `extensions/slash-command-bridge/index.ts`
- `src/interactive-mode-patch.ts`
- `src/workspace-transition-interactive.ts`
- `packages/tallow-tui/src/tui.ts`
- `.plans/clear-and-render-regressions/implementation.md`

### Informative

- `extensions/clear/index.ts`
- `extensions/command-prompt/index.ts`
- `src/sdk.ts`
- `packages/tallow-tui/src/__tests__/tui-diff-regression.test.ts`
