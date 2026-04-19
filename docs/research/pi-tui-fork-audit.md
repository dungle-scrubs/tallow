# pi-tui Fork Audit

Upstream reference version: `0.67.68`

## Long-term keep set

- border styles
- loader global defaults and hide sentinel
- editor ghost-text and change-listener APIs
- minimal reset/render primitives still required by tallow

## Runtime delta classification

| File | Category | Note |
|------|----------|------|
| `border-styles.js` | keep | Local-only border style primitive not present upstream. |
| `components/bordered-box.js` | upstream | Generic component that tallow does not clearly require at runtime. |
| `components/cancellable-loader.js` | revert | Mostly local keybinding drift, not a justified fork surface. |
| `components/editor.js` | keep | Retain only ghost-text and change-listener APIs required by prompt suggestions. |
| `components/image.js` | extract | Image file-path and related app behavior should move out of the fork. |
| `components/loader.js` | keep | Loader defaults and hide sentinel are still used by extensions. |
| `components/markdown.js` | revert | No strong tallow-only requirement found. |
| `components/settings-list.js` | keep | Only the submenu layout transition hook is clearly justified; shrink the rest. |
| `index.js` | keep | Derived export surface; should shrink automatically as kept APIs shrink. |
| `keybindings.js` | revert | Large local namespace drift with weak product justification. |
| `keys.js` | upstream | Audit hunk-by-hunk; keep only proven compatibility fixes and upstream the generic ones. |
| `terminal-image.js` | extract | Image metadata/layout helpers should move to tallow or upstream ownership. |
| `terminal.js` | keep | Alternate screen, progress bar, and terminal protocol support still have real consumers. |
| `test-utils/capability-env.js` | keep | Test-only helper; acceptable to keep locally but not a runtime fork reason. |
| `tui.js` | keep | Only minimal reset/render primitives should survive long-term; high-risk drift must shrink. |
| `utils.js` | extract | Hyperlink/file-link helpers are application helpers and should move to tallow. |
