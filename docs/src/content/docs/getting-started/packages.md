---
title: Packages
description: How tallow's package system works for distributing commands, agents, skills, and hooks.
---

## Packages

tallow has a package system for distributing commands, agents,
skills, and hooks. Packages are directories that contain any
combination of these resources.

### Registering a package

Add local paths to `packages` in your settings file
(`.tallow/settings.json` or `~/.tallow/settings.json`):

```json
{
  "packages": [
    "../my-plugin",
    "~/dev/shared-commands"
  ]
}
```

Each path is scanned for `commands/`, `prompts/`, `agents/`,
`skills/`, and `hooks.json`. Only **local paths** are supported
today — entries starting with `npm:`, `git:`, or `https://` are
skipped because remote repository caching is not yet
implemented.

### Example package layout

```
my-package/
├── commands/
│   ├── deploy.md        → becomes /deploy
│   └── review.md        → becomes /review
├── prompts/
│   └── explain.md       → becomes /explain
├── agents/
│   └── planner.md       → becomes /planner
├── skills/
│   └── my-skill/
│       └── SKILL.md     → loaded by name
└── hooks.json           → merged into hook system
```

All directories are optional. A package with only `commands/`
works. A package with only `hooks.json` works. They compose
freely.

### Commands and prompts are interchangeable

The `commands/` and `prompts/` directories are treated as
synonyms. Files from either directory are merged into a single
command set, deduplicated by name (`prompts/` wins on conflict).

This applies everywhere — inside packages, in `~/.tallow/`,
and in `.tallow/`. Put a markdown file in either directory
and it becomes a `/slash` command.

### Namespacing

Package commands use colon-separated namespaces to avoid
collisions:

| Source | Result |
|--------|--------|
| `.tallow/prompts/deploy.md` | `/deploy` |
| `.tallow/prompts/ops/deploy.md` | `/ops:deploy` |
| `my-package/commands/deploy.md` | `/my-package:deploy` |
| `my-package/prompts/ops/deploy.md` | `/my-package:ops:deploy` |

### What gets loaded

Three extensions independently scan package directories:

| Package feature | Extension | What it does |
|-----------------|-----------|--------------|
| `commands/*.md` | [command-prompt](/extensions/command-prompt/) | Loads markdown files as `/slash` commands |
| `agents/*.md` | [agent-commands](/extensions/agent-commands-tool/) | Loads agent definitions as `/agent-name` commands |
| `hooks.json` | [hooks](/extensions/hooks/) | Loads lifecycle hooks for tool gating, automation, etc. |

Each extension resolves paths from `settings.json` `packages`,
the global `~/.tallow/` directory, and the project-local
`.tallow/` directory. A single package directory with any
combination of these files just works — no adapter or
registration needed.
