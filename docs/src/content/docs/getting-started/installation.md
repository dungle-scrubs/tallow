---
title: Installation
description: How to install and set up tallow.
---

## Requirements

- [Bun](https://bun.sh) >= 1.1

## Quick install

### Published package

Install the CLI with your package manager, then run the installer once to
create `~/.tallow/` and choose extensions and themes:

```bash
bun add -g @dungle-scrubs/tallow
tallow install
```

### From source

Clone the repository, build it, then run the installer:

```bash
git clone https://github.com/dungle-scrubs/tallow.git
cd tallow
bun install
bun run build
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

When finished the installer creates `~/.tallow/` with your
`settings.json`, a `sessions/` directory, and an `extensions/`
directory for any custom extensions you add later.

> The installer manages `~/.tallow/`. Installing or upgrading the
> `tallow` binary itself is handled by your package manager, or by
> rebuilding the repo when running from source.

## Non-interactive install

For CI, scripts, or headless setup, pass `--yes` (or `-y`):

```bash
tallow install --yes

# From a source checkout
node dist/install.js --yes
```

In non-interactive mode, the installer:

- copies any newly bundled template files into `~/.tallow/agents/`
  and `~/.tallow/commands/`, skipping files that already exist
- only changes settings or auth values when you pass explicit flags
  or env vars

For headless auth bootstrapping, provide credentials via env vars
(not CLI args):

```bash
TALLOW_API_KEY=sk-ant-... tallow install --yes --default-provider anthropic
TALLOW_API_KEY_REF=op://Services/Anthropic/api-key tallow install --yes --default-provider anthropic
```

For a first-time headless setup, pass at least one configuration
flag. If you also want to seed provider auth, pair
`--default-provider` with `TALLOW_API_KEY` or `TALLOW_API_KEY_REF`.

## Upgrading

Updating tallow has two separate parts:

1. **Update the CLI/package** using the same method you used to
   install it.
2. **Re-run the installer** only if you want new starter templates
   or want to change installer-managed settings.

### Update the CLI/package

```bash
# Global install
bun add -g @dungle-scrubs/tallow@latest

# From source
cd /path/to/tallow
git pull
bun install
bun run build
```

### Re-run the installer

If tallow is already set up, `tallow install` offers these flows:

| Option | What it actually does |
|--------|------------------------|
| **Refresh starter templates** | Copies any newly bundled template files into `~/.tallow/agents/` and `~/.tallow/commands/`. Existing settings stay untouched. |
| **Reconfigure** | Re-runs extension/theme selection using your current selections as defaults. Updates installer-managed settings (`theme` and `disabledExtensions`) while preserving sessions, auth, hooks, packages, custom extensions, and other settings keys. |
| **Fresh install** | Re-runs the same selection flow from default installer choices instead of your current selections. It still preserves `~/.tallow/` data and only rewrites installer-managed settings. |

For scripted refreshes, use:

```bash
tallow install --yes

# From a source checkout
node dist/install.js --yes
```

Add `--default-provider`, `--default-model`, `--theme`, or
`--thinking` to change only those specific values.

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
| `~/.tallow/.env` | Environment variables loaded at startup (supports `op://` refs) |
| `~/.tallow/.env.cache` | Auto-generated cache of resolved `op://` secrets (1h TTL) |
| `~/.tallow/auth.json` | Provider auth references (not raw keys — see [SECURITY.md](https://github.com/dungle-scrubs/tallow/blob/main/SECURITY.md)) |
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
echo "prompt" | tallow            Piped stdin as prompt
cat file.md | tallow -p "Review"  Piped stdin + explicit prompt
tallow --continue                 Continue most recent session
tallow --session-id my-run        Start or continue a named session
tallow --resume <id>              Resume a specific session (fails if not found)
tallow --fork-session <id>        Fork from an existing session
tallow --list                     List available sessions
tallow extensions                 List extensions (table view)
tallow extensions --json          List extensions as JSON
tallow extensions <id>            Show metadata for one extension
tallow --model claude-sonnet      Use a specific model
tallow --thinking high            Set thinking level
tallow --no-session               In-memory only (no persistence)
tallow --no-extensions            Disable all extensions
tallow -e ./my-ext                Load additional extension
tallow --mode rpc                 RPC mode (for external integrations)
tallow --home                     Print the tallow home directory
tallow install                    Run the interactive installer
```

`--api-key` is intentionally unsupported to avoid leaking secrets in
process arguments. Use `TALLOW_API_KEY` or `TALLOW_API_KEY_REF`.

### Piped input

Pipe file contents or command output directly into tallow:

```bash
# Stdin becomes the prompt
echo "What is 2+2?" | tallow

# Stdin as context + explicit prompt
cat src/main.ts | tallow -p "Find bugs in this code"

# Pipe command output
git log --oneline -20 | tallow -p "Summarize recent changes"

# Works with JSON mode too
cat data.json | tallow --mode json -p "Parse this"
```

When stdin is piped (not a TTY), tallow reads the full stream and
enters print mode automatically. If both stdin and `-p` are
provided, stdin content is prepended as context before the prompt.
Piped input is capped at 10 MB to prevent memory exhaustion.

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
