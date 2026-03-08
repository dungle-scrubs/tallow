## What

Brief description of the change.

## Why

Motivation / problem being solved.

## How

Implementation approach (if non-obvious).

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun test` passes
- [ ] `bun run build` succeeds
- [ ] `bun run test:docs` passes
- [ ] All required GitHub checks are green (verify with `gh pr checks <pr-number>`)

### Docs impact

If this PR adds/removes extensions, themes, agents, or commands:

- [ ] Extension/theme/agent counts updated in README.md, docs index, and overview
- [ ] New extension has a docs page in `docs/src/content/docs/extensions/`
- [ ] `bun run test:docs` passes
