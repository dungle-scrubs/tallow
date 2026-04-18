# Clear and Render Regressions — Progress Report

> Auto-generated from the implementation plan. This is the canonical
> source of truth for what is done and what remains. Update this file as
> features are implemented.

## Phase 1: Reset semantics and leak containment

### M1: Pin leaked prompt sources with failing tests
Source: `extensions/context-fork/index.ts`,
`extensions/slash-command-bridge/index.ts`,
`node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js`

- [ ] Feature: `/clear` after deferred fork completion does not start a
  new turn in the replacement session.
- [ ] Feature: `/clear` after model compaction scheduling does not fire a
  hidden continuation prompt.
- [ ] Feature: new session starts idle with no hidden queued prompt.
- [x] Feature: old-session deferred triggers are cancelled or ignored
  after reset.
- [ ] Feature: test output identifies which trigger source leaked.

### M2: Centralize reset transaction behavior
Source: `src/interactive-mode-patch.ts`,
`src/workspace-transition-interactive.ts`

- [ ] Feature: `/clear` and workspace/session swaps share the same reset
  invariants.
- [ ] Feature: one reset helper owns loader, status, pending message,
  and extension UI clearing.
- [ ] Feature: resetting during compaction leaves no stale loader text.
- [ ] Feature: resetting during forked or deferred work leaves no stale
  status text.
- [ ] Feature: duplicate reset logic between interactive paths is
  removed or reduced to wrappers.

## Phase 2: Render contract and screen clearing

### M3: Remove transcript replay caused by forced redraw spam
Source: `src/interactive-mode-patch.ts`,
`packages/tallow-tui/src/tui.ts`

- [ ] Feature: ordinary idle turn boundaries do not repaint the full
  transcript.
- [x] Feature: stale loader cleanup does not require unconditional
  `requestRender(true)` on every turn end.
- [ ] Feature: rapid message end / agent end sequences keep transcript
  order stable.
- [ ] Feature: reset-triggered rebuilds render once instead of a forced
  redraw cascade.
- [ ] Feature: loader cleanup policy is testable independent of redraw
  policy.

### M4: Make reset screen clearing actually clear the old viewport
Source: `packages/tallow-tui/src/tui.ts`,
`extensions/render-stabilizer/index.ts`

- [ ] Feature: the first render after reset clears stale bottom-of-screen
  artifacts.
- [x] Feature: scrollback clear is honored on reset renders, not only on
  later shrink-triggered full renders.
- [ ] Feature: startup-grace behavior does not leave old transcript lines
  stranded below the current UI.
- [x] Feature: forced invalidation and first-render paths obey the same
  reset clear semantics.
- [ ] Feature: obsolete workaround code is removed or narrowed.

## Phase 3: Proof, observability, and cleanup

### M5: Add reset observability and failure forensics
Source: `src/interactive-mode-patch.ts`, supporting test helpers

- [ ] Feature: reset lifecycle emits deterministic diagnostics in tests
  or debug mode.
- [ ] Feature: deferred trigger registration is observable.
- [ ] Feature: deferred trigger cancellation is observable.
- [ ] Feature: late completions are recorded as dropped after reset,
  rather than silently starting work.
- [ ] Feature: normal interactive mode stays quiet while debug evidence
  remains available.

### M6: Run the full confidence suite and remove stale assumptions
Source: new end-to-end reset fixture plus existing integration suites

- [ ] Feature: dedicated `/clear` end-to-end transcript fixture passes.
- [ ] Feature: `/clear` during compaction passes the end-to-end fixture.
- [ ] Feature: `/clear` during deferred fork completion passes the
  end-to-end fixture.
- [ ] Feature: targeted unit and integration suites pass.
- [ ] Feature: `typecheck`, `typecheck:extensions`, `lint`, TUI build,
  root build, and command e2e all pass.

## Summary

- Total features: 30
- Completed: 4
- Remaining: 26
