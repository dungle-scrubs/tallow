---
title: Creating Extensions
description: How to create your own tallow extensions
---

Extensions are the building blocks of tallow. Each extension provides specific functionality that ships bundled with the application.

## Extension Structure

Each extension lives in the `extensions/` directory:

```
extensions/my-extension/
├── extension.json   # Manifest (required)
├── index.ts         # Entry point
└── README.md        # Documentation (optional)
```

## The Manifest (`extension.json`)

Every extension needs an `extension.json` manifest. This file is the source of truth for extension metadata.

```json
{
  "name": "my-extension",
  "version": "0.1.0",
  "description": "What the extension does in one line",
  "whenToUse": "Use when users need a quick greeting command",
  "capabilities": {
    "commands": ["greet"],
    "events": ["session_start"],
    "tools": ["my_tool"]
  },
  "permissionSurface": {
    "filesystem": "read",
    "shell": false,
    "network": false,
    "subprocess": false
  },
  "category": "tool",
  "tags": ["utility"],
  "files": ["index.ts"],
  "relationships": [],
  "npmDependencies": {}
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique extension name. Must match the directory name. |
| `version` | Yes | Semver version string. |
| `description` | Yes | One-line description. |
| `whenToUse` | No | One-line operator guidance shown in the extension catalog (`Use when ...`). |
| `capabilities` | No | Capability map with optional `tools`, `commands`, and `events` arrays. |
| `permissionSurface` | No | Execution surface object: `filesystem` (`none\|read\|write`), `shell` (bool), `network` (bool), `subprocess` (bool). |
| `category` | No | One of `tool`, `ui`, `utility`, `command`, `integration`, `language-support`, `context`, `alias`. |
| `tags` | No | Searchable tags. |
| `files` | Yes | Files included with the extension. Glob patterns supported. `extension.json` is always included automatically. |
| `relationships` | No | Dependencies and integrations (see below). |
| `npmDependencies` | No | npm packages needed at runtime. |
| `configFiles` | No | Config files to copy or merge into the install root. |
| `piVersion` | No | Minimum pi version required. |

### Catalog metadata tips

Keep catalog fields short and task-oriented:

- **`whenToUse`**, one sentence that starts with `Use when ...`
- **`capabilities`**, list concrete `tools`, `commands`, and `events` exposed by the extension
- **`permissionSurface`**, declare minimal side-effect surface (`filesystem`, `shell`, `network`, `subprocess`)

### Relationships

Extensions can declare relationships with each other:

```json
{
  "relationships": [
    { "name": "hooks", "kind": "requires", "reason": "Needs hook system for event handling" },
    { "name": "tasks", "kind": "enhances", "reason": "Adds progress tracking to task widget" },
    { "name": "old-extension", "kind": "conflicts", "reason": "Replaces old-extension entirely" }
  ]
}
```

- **`requires`**, Hard dependency. Must be present.
- **`enhances`**, Soft link. If both are present, they integrate.
- **`conflicts`**, Cannot coexist.

## Basic Extension

```typescript
// extensions/my-extension/index.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register a slash command
  pi.registerCommand("greet", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello, ${args || "world"}!`, "info");
    },
  });

  // Hook into lifecycle events
  pi.on("session_start", async (_event, ctx) => {
    // Runs when a session starts
  });
}
```

## Development Workflow

After creating or modifying an extension:

```bash
# Typecheck extensions
bun run typecheck:extensions

# Build the project
bun run build

# Test by running tallow
tallow
```

## Type Safety

Extensions are typechecked against the pi API. The project includes a dedicated `tsconfig.extensions.json` and the pre-commit hook validates all extensions before allowing commits.

```bash
# Run extension typecheck manually
bun run typecheck:extensions
```

### Key type rules

- **Tool return types**, `execute()` must return `AgentToolResult<T>` with `content` and `details`. Use `as const` on content type literals (`type: "text" as const`).
- **Widget render callbacks**, `setWidget` factories receive `(tui, theme)`, but viewport `width` comes from the `render(width)` method, not from `tui`.
- **globalThis state**, If your extension stores cross-reload state on `globalThis`, declare the property in `extensions/global.d.ts`:

```typescript
// extensions/global.d.ts
declare global {
  var __piMyExtensionState: Map<string, unknown> | undefined;
}
export {};
```

### Available type packages

These are available as devDependencies for import:

- `@mariozechner/pi-coding-agent`, `ExtensionAPI`, `ExtensionContext`, tools
- `@mariozechner/pi-tui`, `TUI`, `Container`, `Text`, `Key`
- `@mariozechner/pi-ai`, `Model`, `TextContent`, `ImageContent`
- `@mariozechner/pi-agent-core`, `AgentToolResult`, `AgentToolUpdateCallback`
- `@sinclair/typebox`, `Type` for parameter schemas

## Best Practices

1. **Single responsibility**, each extension should do one thing well
2. **Document your extension**, include a README with usage examples
3. **Handle errors gracefully**, provide meaningful error messages via `ctx.ui.notify()`
4. **Declare relationships**, if your extension depends on or enhances another, say so in the manifest
5. **Use `deliverAs` for async messages**, if calling `pi.sendUserMessage()` from an async context (subprocess callback, timer), pass `{ deliverAs: "followUp" }` to avoid errors when the agent is mid-turn
