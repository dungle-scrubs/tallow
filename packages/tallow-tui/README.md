# @mariozechner/pi-tui (Tallow fork)

Tallow vendors a local fork of `@mariozechner/pi-tui` to keep a small set
of UI primitives that upstream still does not expose in the form tallow
needs.

This is **not** a tiny historical snapshot anymore. The authoritative
upstream reference for the current reduction effort is
`@mariozechner/pi-tui@0.67.68`.

## Why the fork existed

The original fork was created because tallow needed a few TUI primitives
that extension APIs could not provide directly:

- configurable loader defaults
- border styles and bordered boxes
- earlier input interception hooks

Since then, upstream added several features that used to be local, so the
current fork is larger than the original rationale justifies.

## Long-term keep surface

The fork reduction effort is shrinking the long-term delta to only the
smallest set of proven tallow requirements:

- border styles
- loader global defaults and hide sentinel
- editor ghost-text and change-listener APIs
- minimal reset/render primitives still required by tallow

Everything else is treated as revert-or-extract unless proven necessary.

## Authoritative audit

Do not trust this README alone for the current delta. The canonical
status document is `docs/research/pi-tui-fork-audit.md`, generated and
validated by the audit script:

```bash
node scripts/audit-pi-tui-fork.mjs
```

To regenerate the human-readable audit note:

```bash
node scripts/audit-pi-tui-fork.mjs \
  --write-markdown docs/research/pi-tui-fork-audit.md
```

The generated report classifies each changed runtime file as one of:

- `keep`
- `extract`
- `upstream`
- `revert`

## Current ownership rules

- `packages/tallow-tui` should own generic TUI primitives only
- tallow session/reset behavior belongs in `src/interactive-*.ts`, not in
  the fork
- application helpers should move to tallow or upstream rather than stay
  in the fork by accident

## Sync approach

1. audit local-vs-upstream runtime deltas
2. revert low-risk files first
3. extract tallow-owned helpers out of the fork
4. keep only the justified primitive surface
5. shrink high-risk render/input deltas last with PTY regression tests
