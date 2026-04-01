---
title: Icons
description: Customize TUI glyphs in tallow.
---

Tallow uses Unicode glyphs throughout the TUI for status
indicators, spinners, and task states. All of them can be
overridden via the `icons` key in `~/.tallow/settings.json`.

## Configuration

Add an `icons` object to your settings. Only keys you set
are overridden — everything else keeps its default.

```json
{
  "icons": {
    "success": "✔",
    "error": "✘",
    "pending": "□",
    "spinner": ["⠋", "⠙", "⠹", "⠸"]
  }
}
```

Changes take effect on the next session start.

## Available keys

| Key | Default | Used for |
|-----|---------|----------|
| `success` | `✓` | Successful operations, completed tasks |
| `error` | `✗` | Failed operations, errors |
| `pending` | `☐` | Pending/not-started tasks |
| `in_progress` | `●` | In-progress tasks, active connections |
| `idle` | `○` | Idle status, inactive connections |
| `waiting` | `⏳` | Waiting/queued teammates |
| `active` | `⚡` | Active/working teammates |
| `blocked` | `◇` | Blocked tasks |
| `unavailable` | `⊘` | Unavailable resources |
| `spinner` | `["◐","◓","◑","◒"]` | Animated spinner frames in widgets |
| `task_list` | `📋` | Task list indicator |
| `comment` | `💬` | Task comments |

## Examples

### High-contrast (ASCII-only)

For terminals with limited Unicode support:

```json
{
  "icons": {
    "success": "[OK]",
    "error": "[ERR]",
    "pending": "[ ]",
    "in_progress": "[..]",
    "idle": "[-]",
    "spinner": ["/", "-", "\\", "|"]
  }
}
```

### Nerd Font

If your terminal uses a [Nerd Font](https://www.nerdfonts.com/):

```json
{
  "icons": {
    "success": "",
    "error": "",
    "pending": "",
    "in_progress": "",
    "spinner": ["󰪞", "󰪟", "󰪠", "󰪡", "󰪢", "󰪣", "󰪤", "󰪥"]
  }
}
```

### Minimal

```json
{
  "icons": {
    "success": "+",
    "error": "x",
    "pending": "-",
    "in_progress": "*",
    "spinner": [".", "o", "O", "o"]
  }
}
```

## IDE autocompletion

After running `tallow install`, your `settings.json` includes
a `$schema` reference that gives you autocompletion and
validation for all icon keys in VS Code and other editors
that support JSON Schema.

## How it works

The `_icons` extension reads icon overrides from settings on
session start and populates a global registry. All other
extensions call `getIcon(key)` instead of hardcoding glyphs.
The spinner key returns an array of frames used for animated
progress indicators in the task widget, subagent widget, and
background task widget.
