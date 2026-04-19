---
number: 01
title: "Reduce pi-tui fork drift against upstream"
type: refactor
status: Draft
author: Kevin Frilot
date: 2026-04-18
---

# RFC-01: Reduce pi-tui fork drift against upstream

## Abstract

<!-- D-001 --> Tallow's local `packages/tallow-tui` fork started as a
small escape hatch for a few missing TUI primitives, but it has drifted
into a much larger rendering and input surface. The current delta makes
render bugs harder to attribute, keeps outdated fork documentation in
place, and hides which changes are genuine product requirements versus
accumulated workaround debt. This RFC defines a fork-reduction effort
that shrinks the long-term delta against latest upstream
`@mariozechner/pi-tui`, preserves only the primitives tallow still
requires, and moves application-specific behavior back into the tallow
codebase or upstream where appropriate.

## Introduction

The fork rationale used to be simple: a few primitives were missing and
extension APIs were not enough. That is no longer the actual state.
Latest upstream now contains several capabilities that used to be local,
while our fork still carries broad differences in rendering, input,
terminal, and selector behavior. That mismatch creates two problems:

1. the fork is harder to maintain than it appears from the docs
2. instability in resume/reset rendering gets masked as a generic TUI
   problem rather than a concrete local delta

This RFC covers:

- documenting the real fork surface against upstream `0.67.68`
- classifying every local delta into keep, revert, extract, or upstream
- shrinking the fork in staged, test-backed passes
- preserving only the minimal long-term delta required by tallow

This RFC does not cover:

- rewriting the entire TUI architecture from scratch
- forking `pi-coding-agent`
- changing product features unrelated to the fork delta audit

## Terminology

The key words "MUST", "MUST NOT", "SHOULD", and "MAY" in this document
are to be interpreted as described in RFC 2119.

- **Fork delta**: any runtime or API behavior in
  `packages/tallow-tui` that differs from latest upstream.
- **Keep**: a local change that tallow still requires and cannot yet
  remove safely.
- **Extract**: a local change that is useful, but belongs in tallow or a
  shared helper rather than inside the TUI fork.
- **Revert**: a local change that SHOULD be replaced with latest
  upstream behavior.
- **Upstream candidate**: a generic improvement that SHOULD live in
  upstream `pi-tui` rather than a permanent local fork.

## Current State

<!-- D-002 --> The original fork reason was small: configurable loader
behavior, border styles, bordered box support, and earlier input
interception needs. The current fork is not small. Comparing local build
output to latest upstream package contents shows 21 changed or local-only
runtime files. Several of those differences are no longer justified by
current product needs because upstream already ships equivalent features
such as autocomplete, box, cancellable loader, and richer editor/input
infrastructure.

The currently obvious keep set is much smaller than the full diff:

- border styles
- loader defaults and hide sentinel
- editor ghost-text and change-listener APIs
- image file-path hook, if still required
- a narrow set of reset/render primitives used by tallow today

Everything else should be treated as suspicious until proven necessary.

## Proposed Changes

<!-- D-003 --> The fork reduction effort MUST classify every changed file
into one of four outcomes: keep, extract, upstream, or revert.

### Keep set

The fork SHOULD retain only the smallest surface that tallow clearly
depends on:

- `border-styles.ts`
- the minimal loader API extensions used by spinner customization and
  hidden working messages
- the minimal editor API extensions used by prompt suggestions
- the minimal reset/render primitives still required by tallow runtime
  session transitions

### Extract set

Application-specific helpers SHOULD move out of the fork into tallow,
including link helpers and image-metadata helpers where they do not need
TUI ownership.

### Revert set

Files with no strong tallow-specific requirement SHOULD be restored to
latest upstream behavior in low-risk passes first. This includes obvious
candidates such as markdown, text, stdin buffer, and likely parts of
autocomplete and input handling.

### Upstream set

Generic improvements that still matter after reduction SHOULD be offered
upstream instead of retained as permanent local debt.

## Migration Strategy

The reduction proceeds in ordered passes:

1. document the real delta and rewrite stale fork docs
2. revert low-risk files with no tallow-specific requirement
3. extract app-specific helpers out of the fork
4. preserve only the truly required local primitives
5. shrink the high-risk render/input files last, with PTY and full-suite
   validation after each pass

This sequence minimizes risk while steadily reducing fork surface.

## Security Considerations

<!-- D-004 --> Resume/reset rendering bugs and input corruption in a forked
terminal layer are not merely cosmetic. They can lead to ghost input,
confusing state replay, and unexpected command execution. Reducing fork
surface lowers the number of local code paths that can corrupt terminal
state or replay stale content.

## Risk Assessment

Primary risks:

- reverting too aggressively breaks a tallow feature that quietly depends
  on local fork APIs
- mixed ownership between fork code and tallow runtime patches remains
  unclear after reduction
- latest upstream behavior still contains edge cases that local patches
  were compensating for

Mitigations:

- classify every file explicitly before changing it
- keep PTY resume/reset regressions in the validation suite
- move app-specific behavior into tallow first so the fork can shrink
  safely

## Testing Strategy

<!-- D-005 --> Every reduction pass MUST be backed by targeted tests and
full validation. The minimum validation bar is:

1. file-level targeted tests for changed TUI behaviors
2. PTY-based interactive regressions for resume/reset behavior
3. full `bun test`
4. `typecheck`, `typecheck:extensions`, `lint`
5. fork build plus root build
6. slash-command registration e2e

## Implementation Plan

Implementation details live in:

- `.plans/pi-tui-fork-shrink/implementation.md`
- `.plans/pi-tui-fork-shrink/progress-report.md`

The work is organized into four phases:

1. baseline and documentation correction
2. low-risk upstream re-sync
3. extract tallow-owned helpers and preserve justified local primitives
4. shrink high-risk render/input deltas and finish with full validation

## Open Questions

At draft time, the main open question is not whether the fork is too
large — it is — but which high-risk render/input hunks are still
required after the low-risk and extraction passes. Those will be decided
with test-backed evidence during implementation rather than assumed up
front.

## References

### Normative

- `AGENTS.md`
- `packages/tallow-tui/README.md`
- `.plans/pi-tui-fork-shrink/implementation.md`

### Informative

- `docs/src/content/docs/changelog.md`
- latest npm package `@mariozechner/pi-tui@0.67.68`
