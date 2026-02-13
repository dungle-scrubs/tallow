---
title: Installation
description: How to install and set up tallow.
---

## Requirements

- [Node.js](https://nodejs.org) >= 22

## Quick install

Clone the repository and run the interactive installer:

```bash
git clone https://github.com/dungle-scrubs/tallow.git
cd tallow
npm install
npm run build
node dist/install.js
```

The installer walks you through:

1. **Scope** — install everything or pick individual extension
   groups and themes.
2. **Extension groups** — Core Tools, Agent & Delegation,
   Developer Tools, and UI & Experience. Each group can be
   enabled or disabled as a unit.
3. **Themes** — choose which of the 34 built-in themes to
   include and pick a default.
4. **Global binary** — optionally run `npm link` so the
   `tallow` command is available everywhere.

When finished the installer creates `~/.tallow/` with your
`settings.json`, a `sessions/` directory, and an `extensions/`
directory for any custom extensions you add later.

## Non-interactive install

For CI, scripts, or quick rebuilds, pass `--yes` (or `-y`):

```bash
node dist/install.js --yes
```

This rebuilds from source, reinstalls the global binary, and
keeps all existing settings untouched. It requires an existing
`~/.tallow/` directory — run the interactive installer at least
once first.

## Upgrading

If tallow is already installed, the installer detects it
automatically and offers three options:

| Option | What it does |
|--------|--------------|
| **Upgrade in place** | Rebuild and reinstall. All settings, sessions, auth, hooks, and packages are preserved. |
| **Reconfigure** | Re-run the extension/theme selection flow. Sessions, auth, hooks, and custom extensions are preserved. |
| **Fresh install** | Reset `settings.json` to defaults. Sessions, auth, hooks, and custom extensions are still preserved. |

You can also upgrade non-interactively:

```bash
cd /path/to/tallow
git pull
node dist/install.js --yes
```

## After installation

```bash
# Verify
tallow --version

# Run in any project directory
tallow
```

## Configuration

User configuration lives in `~/.tallow/`. Project-local
configuration lives in `.tallow/` within your project directory.

| Path | Purpose |
|------|---------|
| `~/.tallow/settings.json` | Global settings (theme, disabled extensions, packages) |
| `~/.tallow/auth.json` | API keys for model providers |
| `~/.tallow/sessions/` | Conversation history |
| `~/.tallow/extensions/` | Custom user extensions |
| `~/.tallow/agents/` | Custom user agents |
| `~/.tallow/skills/` | Custom user skills |
| `~/.tallow/prompts/` | Custom user prompts/commands |
| `.tallow/settings.json` | Project-local settings (deep-merged over global) |
| `.tallow/extensions/` | Project-local extensions |
| `.tallow/agents/` | Project-local agents |
| `.tallow/skills/` | Project-local skills |
| `.tallow/prompts/` | Project-local prompts/commands |

## CLI reference

```
tallow                            Interactive mode
tallow -p "Fix the tests"         Single-shot print mode
tallow --continue                 Continue most recent session
tallow --session-id my-run        Start or continue a named session
tallow --resume <id>              Resume a specific session (fails if not found)
tallow --fork-session <id>        Fork from an existing session
tallow --list                     List available sessions
tallow --model claude-sonnet      Use a specific model
tallow --thinking high            Set thinking level
tallow --no-session               In-memory only (no persistence)
tallow --no-extensions            Disable all extensions
tallow -e ./my-ext                Load additional extension
tallow --mode rpc                 RPC mode (for external integrations)
tallow --home                     Print the tallow home directory
tallow install                    Run the interactive installer
```

### Session targeting (headless / CI)

For deterministic session management in CI/CD pipelines and SDK consumers:

```bash
# Named session — creates on first use, continues on subsequent calls
tallow -p "step 1" --session-id my-pipeline-run
tallow -p "step 2" --session-id my-pipeline-run

# Strict resume — fails with exit code 1 if session doesn't exist
tallow -p "continue" --resume my-pipeline-run

# Fork — branch from an existing session into a new one
tallow -p "explore alternative" --fork-session my-pipeline-run

# Session ID is emitted to stderr for programmatic chaining
tallow -p "hello" --session-id run-1 2>session.txt
```

`--session-id`, `--resume`, `--fork-session`, and `--continue` are mutually exclusive.
`--no-session` takes highest priority and disables all persistence.

Session discovery is project-scoped: `--list` and default resume flows read
sessions for the current working directory only, not a global cross-project pool.
