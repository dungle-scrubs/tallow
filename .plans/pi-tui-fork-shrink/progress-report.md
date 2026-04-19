# pi-tui Fork Shrink — Progress Report

> Auto-generated from the implementation plan. This file is the
> canonical source of truth for what is done and what remains.

## Phase 1: Baseline and fork truth

### M1: Rewrite stale fork documentation
Source: `packages/tallow-tui/README.md`, `AGENTS.md`,
`docs/src/content/docs/changelog.md`

- [x] Feature: fork README reflects current upstream baseline rather than
  stale `v0.52.9` assumptions.
- [x] Feature: fork docs no longer claim input middleware is a current
  fork justification.
- [x] Feature: documented keep surface matches real exported APIs.
- [x] Feature: conflict surface documentation matches current local
  ownership.

### M2: Produce authoritative delta inventory
Source: local fork audit scripts and latest upstream package contents

- [x] Feature: changed runtime files are enumerated reproducibly.
- [x] Feature: every changed runtime file is classified as keep,
  extract, upstream, or revert.
- [x] Feature: must-keep API set is recorded explicitly.
- [x] Feature: file-by-file audit remains readable and reviewable.

## Phase 2: Low-risk upstream re-sync

### M3: Re-sync low-risk files to upstream
Source: `autocomplete.ts`, `components/input.ts`, `components/markdown.ts`,
`components/text.ts`, `stdin-buffer.ts`

- [x] Feature: autocomplete behavior remains correct after upstream sync.
- [x] Feature: input component behavior remains correct after upstream
  sync.
- [x] Feature: markdown rendering remains correct after upstream sync.
- [x] Feature: text rendering remains correct after upstream sync.
- [x] Feature: stdin buffering remains correct after upstream sync.

### M4: Re-sync selector and keybinding drift
Source: `components/select-list.ts`, `components/settings-list.ts`,
`keybindings.ts`, `keys.ts`

- [x] Feature: select list interaction still supports tallow's required
  UX after sync.
- [x] Feature: settings list retains only the submenu transition hook if
  still needed.
- [x] Feature: keybinding behavior reflects real tallow requirements,
  not historical drift.
- [x] Feature: key parsing retains only proven compatibility fixes.

## Phase 3: Extract tallow-owned behavior

### M5: Extract app-level helpers from the fork
Source: `utils.ts`, `terminal-image.ts`, `components/image.ts`

- [x] Feature: hyperlink/file-link helpers move out of the fork without
  breaking extension consumers.
- [x] Feature: image metadata/layout helpers move to tallow or upstream
  ownership.
- [x] Feature: image file-path injection no longer requires fork-owned
  app state smuggling.
- [x] Feature: extension consumers still pass after helper extraction.

### M6: Preserve only justified local primitives
Source: `border-styles.ts`, `components/loader.ts`, `components/editor.ts`,
`editor-component.ts`

- [x] Feature: border styles remain available if upstream still lacks
  them.
- [x] Feature: loader default frames/interval and hide sentinel remain
  available where tallow still uses them.
- [x] Feature: editor ghost-text and change-listener APIs remain
  available for prompt suggestions.
- [x] Feature: no unrelated editor/loader drift remains after reduction.

## Phase 4: High-risk render/input shrink and final validation

### M7: Shrink high-risk render/input files
Source: `tui.ts`, `terminal.ts`, reset-related runtime integration

- [x] Feature: resume no longer reprints transcript via local drift.
- [x] Feature: `/clear` and reset flows remain stable after high-risk
  fork shrink.
- [x] Feature: typing does not trigger ghost input or replayed content.
- [x] Feature: surviving reset/render primitives are minimal and
  explicit.

### M8: Final fork delta verification
Source: audit script plus full validation suite

- [x] Feature: final fork delta matches documented keep set exactly.
- [x] Feature: `bun test` passes.
- [x] Feature: typecheck, extension typecheck, and lint pass.
- [x] Feature: fork build, root build, and slash-command e2e pass.
- [x] Feature: one canonical fork status document remains after cleanup.

## Summary

- Total features: 34
- Completed: 34
- Remaining: 0
