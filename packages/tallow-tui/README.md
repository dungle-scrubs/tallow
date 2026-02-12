# @tallow/tui

Tallow's fork of `@mariozechner/pi-tui` (v0.52.9). Adds customizable
loader, border styles, and input middleware — changes that require
modifying pi-tui internals.

## What's different from upstream

### Configurable Loader

`Loader` accepts optional `frames` and `intervalMs` via constructor
options. Static `Loader.defaultFrames` / `Loader.defaultIntervalMs`
let extensions set global defaults at session start.

### Border styles

New `BorderStyle` interface with three presets: `SHARP` (┌┐└┘),
`ROUNDED` (╭╮╰╯), `FLAT` (horizontal rules only).
`BorderedBox` component wraps content in a full border with optional
title, padding, and color functions.

### Input middleware

`TUI.addInputMiddleware(fn)` inserts a hook before `handleInput`
forwards to the focused component. Middleware returns `true` to
consume input. Used by the which-key overlay extension.

## Upstream sync

Source extracted from `@mariozechner/pi-tui@0.52.9` source maps.

### Modified files (conflict surface on sync)

| File | Change |
|------|--------|
| `components/loader.ts` | Constructor options, static defaults |
| `tui.ts` | Input middleware array + add/remove methods |

### Added files (zero conflict)

| File | Purpose |
|------|---------|
| `border-styles.ts` | BorderStyle interface + presets |
| `components/bordered-box.ts` | Box component with configurable borders |

### How to sync

1. Extract new upstream source from source maps (same script)
2. Diff against `src/` — conflicts only in modified files above
3. Apply upstream changes, keep our additions
4. Rebuild: `cd packages/tallow-tui && npm run build`
