---
title: Introduction
description: Why tallow exists and what it does.
---

## What is tallow?

tallow is an opinionated coding agent built on pi. It bundles
51 extensions, 8 agent profiles, 34 themes, and a skill system
into a single install. No manual extension management —
everything ships together, ready to use.

## What is [pi](https://github.com/badlogic/pi-mono)?

pi is the terminal-native coding agent framework. It runs in
your terminal, connects to any LLM provider, and gives you full
control over how the agent behaves through extensions, themes,
hooks, skills, and commands.

## What ships out of the box

### Extensions (51)

Every feature is an extension. They're organized by category:

| Category | Extensions | Examples |
|----------|-----------|----------|
| **Tools** (19) | Core coding tools and agent capabilities | bash, edit, read, write, cd, web_fetch, web_search, subagent, teams, tasks, plan-mode, MCP adapter, session-memory, wezterm-pane-control |
| **UI & Display** (6) | Terminal rendering and status | custom footer, git status, tool display, minimal skill display, session-namer, random-spinner |
| **Commands** (7) | Prompt/command system | command-prompt, command-expansion, context-fork, health, shell-interpolation, skill-commands |
| **Utilities** (6) | Helper features | cheatsheet, context-usage, debug, init, show-system-prompt, read-tool-enhanced |
| **Integrations** (3) | External system hooks | lifecycle hooks, claude-bridge, worktree |
| **Language Support** (1) | IDE-like features | LSP (TypeScript, Python, Rust, Swift, PHP) |
| **Context** (1) | Instruction loading | context-files (CLAUDE.md + AGENTS.md) |
| **Dev** (1) | Development tools | upstream-check |
| **Aliases** (1) | Convenience shortcuts | /clear → /new |
| **Core** (1) | Internal infrastructure | \_icons (icon registry) |

Each extension has an `extension.json` manifest with a
`category` property that drives the documentation sidebar
and the installer's grouping. See
[Creating Extensions](/development/creating-extensions/) for
the full manifest spec.

### Agents (8)

Built-in agent profiles, each with a specialized role and
system prompt. Invoke any agent as a `/slash` command:

| Agent | Purpose |
|-------|---------|
| `/architect` | High-level architecture — plans before coding |
| `/debug` | Methodical root cause analysis |
| `/planner` | Read-only planning from context and requirements |
| `/refactor` | Improve code structure without changing behavior |
| `/reviewer` | Code review for quality and security |
| `/scout` | Fast codebase recon for handoff to other agents |
| `/worker` | General-purpose agent with full capabilities |

Some agents restrict their tool access (e.g. `planner` and
`reviewer` are read-only) to enforce their role.

### Themes (34)

From Tokyo Night to Synthwave 84, every color in the TUI —
borders, backgrounds, accents, tool status indicators — is
token-driven and overridable. Create your own as a single
JSON file.

### Skills

Skills are markdown-based instruction sets that the model
loads on demand when a task matches the skill's description.
tallow supports skills from the
[tallow-plugins](https://github.com/dungle-scrubs/tallow-plugins)
package system and from your own `~/.tallow/skills/` or
`.tallow/skills/` directories.

Skills have frontmatter metadata including `name`,
`description`, optional `allowed-tools`, and optional
`metadata` (with fields like `author`, `version`,
`argument-hint`).

## What makes it different

- **Batteries included** — 51 extensions loaded automatically.
  No separate install step.
- **Extensible from the ground up** — features are extensions,
  not hard-coded. Don't like how bash output renders? Replace
  the extension. Want a custom status bar? Write one.
- **Multi-model** — run Claude, GPT-4, Gemini, or any
  OpenAI-compatible model from the same interface.
- **Multi-agent** — spawn parallel agents with different models,
  roles, and tasks. Coordinate via shared task boards.
- **Themeable** — 34 built-in themes, every color token
  overridable. Your terminal, your palette.
- **Packages** — a plugin system for distributing commands,
  agents, skills, and hooks. Local paths only — remote
  repositories are not yet supported.
- **Claude Code compatibility** — tallow reads `.claude/`
  resources directly. See
  [Using tallow in existing Claude Code projects](/guides/coming-from-claude-code/)
  for the exact compatibility matrix and caveats.
- **Commands and prompts are interchangeable** — the
  `commands/` and `prompts/` directories are treated as
  synonyms. Files from either directory are merged into a
  single set, deduplicated by name. Put a markdown file in
  `commands/` or `prompts/` and it becomes a `/slash` command.
