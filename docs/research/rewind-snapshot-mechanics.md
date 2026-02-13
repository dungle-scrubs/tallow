# /rewind — Snapshot Mechanics Research

Research into git snapshot mechanics, in-memory tracking, and rollback
strategies for the `/rewind` command.

## Strategy Comparison

### Option A: Git Temporary Commits (Recommended)

**Mechanism**: After each agent turn completes, run
`git add -A && git commit -m "tallow:snapshot:turn-N"`. To rewind, run
`git reset --hard $SHA && git clean -fd`.

| Aspect | Details |
|--------|---------|
| **Snapshot** | `git add -A && git commit --no-verify -m "tallow:snapshot:turn-N"` |
| **Rewind** | `git reset --hard $TARGET_SHA && git clean -fd` |
| **Cleanup** | `git reset --soft $BASELINE` on session end (squashes snapshot commits away) |
| **Tracks untracked files** | ✅ via `git add -A` |
| **Tracks deletions** | ✅ |
| **Tracks binary files** | ✅ |
| **Non-destructive during session** | ✅ agent continues working normally |
| **Conflict-free rollback** | ✅ `reset --hard` never conflicts |

**Pros**:

- Atomic snapshots — every file state captured exactly
- No merge conflicts on rewind (hard reset is unconditional)
- Handles new files, deleted files, renames, binaries
- Cheap: `git add -A && commit` takes ~10ms on typical repos
- `git diff $TURN_A $TURN_B --stat` shows exactly what changed between turns
- Can rewind to any turn, not just the previous one

**Cons**:

- Pollutes git reflog (minor — snapshots are internal commits)
- Requires cleanup on session end (`git reset --soft $BASELINE`)
- Only works inside git repos (need fallback for non-git directories)
- `git clean -fd` removes ALL untracked files, including ones not
  created by the agent (mitigated by tracking which files were untracked
  at session start)
- Moves HEAD — if user has staged changes pre-session, they get committed
  into the snapshot (mitigated by capturing initial state)

### Option B: Git Stash (Non-destructive Snapshots)

**Mechanism**: `git stash create` + `git stash store` to save workspace
state without modifying it. To rewind, `git checkout -- . && git clean -fd`
then reconstruct from stash.

| Aspect | Details |
|--------|---------|
| **Snapshot** | `git add -A && git stash create "msg"` + `git stash store` |
| **Rewind** | `git checkout -- . && git clean -fd`, then reconstruct from stash tree |
| **Cleanup** | `git stash drop` for each snapshot on session end |

**Pros**:

- Doesn't create commits (cleaner git history)
- Non-destructive: workspace stays as-is after snapshot

**Cons**:

- **Reconstruction is unreliable** — `git stash apply` uses 3-way merge
  and can conflict. Tested: applying stash@{1} over a clean checkout
  produced merge conflicts
- Stash tree extraction (`read-tree` + `checkout-index`) leaks files
  from later turns that exist in the index
- `git diff HEAD stash@{N} | git apply` fails when files already exist
- Stash indices shift as new stashes are added (fragile addressing)
- `git stash create` doesn't capture untracked files in the 3rd parent
  unless preceded by `git add -A`, at which point you've staged everything
  anyway

**Verdict**: Stash is unsuitable for multi-turn rollback due to merge
conflicts during reconstruction. Temporary commits are strictly superior.

### Option C: In-Memory File Snapshots

**Mechanism**: Before each write/edit tool execution, read the file's
current contents into a Map. Store `Map<turn, Map<filepath, content>>`.
To rewind, write all files back from the map.

**Pros**:

- Works outside git repos
- No git state pollution
- Can track exact files the agent touched (precise rollback)

**Cons**:

- **Memory pressure**: A session modifying 50 files averaging 10KB each
  across 20 turns = ~10MB (acceptable). But large files (node_modules
  operations, database dumps, images) could spike to hundreds of MB.
- **Doesn't capture bash file operations**: `sed -i`, `mv`, `cp`, `rm`,
  redirects (`>`), `patch`, `chmod` — none of these go through the
  write/edit tool pipeline
- **Can't track deletions** without filesystem watching
- **Can't track new files** created by bash unless post-hoc diffing
- **Incomplete**: Only captures files modified through tracked tools,
  missing the majority of bash-based modifications

**Verdict**: Insufficient as a standalone approach because bash tool file
modifications are invisible. Only useful as a metadata layer on top of git.

### Option D: Hybrid (Git Snapshots + In-Memory Metadata)

**Mechanism**: Use git temporary commits for actual rollback (Option A).
Use in-memory tracking for UI metadata (which files changed per turn,
which tool modified them).

This is the recommended approach. Details in the next section.

## Recommended Approach: Hybrid

### Architecture

```
┌────────────────────────────────────┐
│         RewindTracker              │
│                                    │
│  turnSnapshots: Map<turnIndex, {   │
│    commitSha: string,              │
│    timestamp: number,              │
│    filesChanged: FileChange[],     │
│    toolCalls: ToolCallSummary[],   │
│  }>                                │
│                                    │
│  baselineCommit: string | null     │
│  baselineUntrackedFiles: Set       │
│  isGitRepo: boolean                │
│                                    │
│  snapshot(turnIndex) → void        │
│  rewindTo(turnIndex) → void        │
│  getChangeSummary() → TurnDiff[]   │
│  cleanup() → void                  │
└────────────────────────────────────┘
```

### Snapshot Flow

1. **Session start** (`session_start` event):
   - Check if cwd is a git repo (`git rev-parse --is-inside-work-tree`)
   - If yes: record `baselineCommit = git rev-parse HEAD`
   - Record `baselineUntrackedFiles = git ls-files --others --exclude-standard`
   - If no: disable rewind (show message), or fall back to in-memory only

2. **After each turn** (`turn_end` event):
   - Run `git add -A && git commit --no-verify --allow-empty -m "tallow:snapshot:turn-N"`
   - Record the commit SHA in `turnSnapshots`
   - Also record metadata gathered during the turn from `tool_result` events

3. **During each turn** (`tool_result` event):
   - For `write`: record `{ path, action: "write" }`
   - For `edit`: record `{ path, action: "edit" }`
   - For `bash`: record `{ command }` — the git diff after the turn
     will capture whatever files changed

4. **On `/rewind`**:
   - Show turn selector UI (message list with file change summaries)
   - User picks a turn
   - Run `git reset --hard $TARGET_SHA`
   - Run `git clean -fd` but only remove files NOT in `baselineUntrackedFiles`
   - Restore HEAD: `git reset --soft $BASELINE_COMMIT` (preserves files,
     moves HEAD back to where it was)

5. **Session end** (`session_shutdown` event):
   - Cleanup: `git reset --soft $BASELINE_COMMIT` (removes snapshot commits
     from history while preserving current file state)

### Event Hooks Required

```typescript
// Available events from the framework:
pi.on("session_start", ...)   // Initialize baseline
pi.on("turn_end", ...)        // Create snapshot after each turn
pi.on("tool_result", ...)     // Track file modifications per turn
pi.on("session_shutdown", ...) // Cleanup snapshot commits
```

All four events exist in the framework and are emitted reliably.

## Edge Case Matrix

| Edge Case | Git Commits Approach | Handling |
|-----------|---------------------|----------|
| Files modified by bash (`sed -i`, `>`, `mv`) | ✅ Captured by `git add -A` at turn end | No special handling needed |
| New files created during session | ✅ `git add -A` stages untracked files | Tracked automatically |
| Files deleted during session | ✅ `git add -A` stages deletions | `git reset --hard` restores them |
| Binary files | ✅ Git handles binary blobs | May increase `.git` size temporarily |
| Files outside working directory | ❌ Not tracked | Show warning; these can't be rewound |
| Files modified by `git checkout/merge/reset` | ⚠️ Snapshot captures post-git-command state | Works, but user's git operations are interleaved with snapshots |
| Concurrent modifications by other processes | ⚠️ Captured at snapshot time | May include unrelated changes |
| Very large files (>100MB) | ⚠️ Slow `git add` | Consider `.gitignore` or size threshold warning |
| Symbolic links | ✅ Git tracks symlinks | Restored correctly by `reset --hard` |
| Files in `.gitignore` | ❌ Not tracked by `git add -A` | Need `git add -A --force` for ignored files, or accept limitation |
| Non-git directories | ❌ No git available | Fall back to in-memory snapshots or disable rewind |
| User has uncommitted changes pre-session | ⚠️ First snapshot includes them | Baseline commit captures initial state; rewind to baseline restores pre-session state |
| User has staged changes pre-session | ⚠️ Mixed into first snapshot commit | Record and restore staging area separately, or document limitation |

## Bash Tracking Analysis

### The Problem

The agent's bash tool can run arbitrary commands that modify files:
`sed -i`, `mv`, `cp`, `rm`, `tee`, `>` / `>>`, `touch`, `chmod`,
`patch`, `npm install`, `git checkout`, etc. These bypass the write/edit
tool pipeline entirely.

### Approaches Evaluated

| Approach | Feasibility | Issues |
|----------|-------------|--------|
| Parse bash commands for file ops | ❌ Impossible | Pipes, subshells, aliases, scripts make this intractable |
| `fswatch`/`inotify` filesystem watching | ❌ Not available | macOS doesn't ship `fswatch`; cross-platform nightmare |
| Diff after each tool execution | ✅ Works | `git status --porcelain` takes ~5ms; cheap enough per tool call |
| Diff only at turn boundaries | ✅ Best | Single `git add -A && commit` per turn; captures everything |

### Recommendation

**Snapshot at turn boundaries** (`turn_end` event). This captures all
file modifications regardless of how they happened — write tool, edit
tool, bash tool, or any subprocess. The git commit atomically records
the entire workspace state.

Per-tool tracking via `tool_result` events is supplementary metadata for
the UI (showing "write: src/foo.ts" vs "bash: npm install"). The actual
rollback mechanism doesn't depend on it.

## TUI Components for Message Selector

### Available Primitives

| Component | Location | Suitability |
|-----------|----------|-------------|
| `SelectList` | `packages/tallow-tui/src/components/select-list.ts` | ✅ Scrollable list with arrow nav, filter, enter/escape |
| `SettingsList` | `packages/tallow-tui/src/components/settings-list.ts` | ❌ Wrong interaction model (settings, not selection) |
| `TreeSelectorComponent` | `node_modules/.../components/tree-selector.js` | 🔶 Session tree navigation; similar UX but too complex |
| `BorderedBox` | `packages/tallow-tui/src/components/bordered-box.ts` | ✅ Container with borders for the selector UI |
| `Container` | `packages/tallow-tui/src/tui.ts` | ✅ Layout composition |
| `Text` | `packages/tallow-tui/src/components/text.ts` | ✅ Labels |
| `Spacer` | `packages/tallow-tui/src/components/spacer.ts` | ✅ Spacing |

### Recommended UI Pattern

Use `ctx.ui.custom()` with a custom `Component` that wraps `SelectList`.
Each item represents a turn with:

- **label**: `Turn N` or truncated user message
- **description**: File change summary (e.g., "3 files: src/foo.ts, ...")

This mirrors how `/fork` and the tree selector work — a scrollable list
of conversation points.

```
┌─────────────────────────────────────────┐
│ ⏪ Rewind to...                         │
│                                         │
│ → Turn 3: "fix the login bug"           │
│     3 files: src/auth.ts, src/login.tsx  │
│   Turn 2: "add error handling"          │
│     1 file: src/api.ts                  │
│   Turn 1: "create the project"          │
│     5 files: package.json, src/...      │
│                                         │
│   ↑↓ navigate · enter select · esc cancel│
└─────────────────────────────────────────┘
```

The existing `SelectList` component handles arrow navigation, scrolling
for long lists, enter to confirm, and escape to cancel. No new TUI
primitives are needed.

## Performance Considerations

| Operation | Cost | Frequency | Impact |
|-----------|------|-----------|--------|
| `git rev-parse HEAD` | ~3ms | Once at session start | Negligible |
| `git status --porcelain` | ~5ms | Once per turn (for metadata) | Negligible |
| `git add -A` | ~10ms (small repo) to ~200ms (large repo) | Once per turn | Low |
| `git commit --no-verify` | ~15ms | Once per turn | Low |
| `git reset --hard` | ~10ms | Once on rewind | Negligible |
| `git clean -fd` | ~5ms | Once on rewind | Negligible |
| `git reset --soft` | ~3ms | Once on session end | Negligible |
| In-memory metadata | ~1KB per turn | Continuous | Negligible |

**Total overhead per turn**: ~25ms for snapshot (git add + commit).
This runs AFTER the turn completes (in the `turn_end` handler),
so it doesn't block the agent or add latency to tool execution.

**Disk overhead**: Each snapshot commit stores a delta. For typical
coding sessions modifying text files, this adds kilobytes per turn.
Git's packfile format is highly efficient for text diffs. Even a
50-turn session would add <1MB to `.git/`.

## Critical Design Decisions

### 1. When to snapshot

**After turn end** (`turn_end` event), not after each tool call.
Reasoning: a single turn may involve multiple tool calls (read → edit →
write → bash). Snapshotting per tool call would create excessive commits
and make the selector unwieldy. Per-turn snapshots align with the user's
mental model of "undo what the agent did in response to my last message."

### 2. How to handle non-git directories

Options:
- **(a)** Disable `/rewind` with a clear message
- **(b)** Auto-init a git repo (`git init`)
- **(c)** Fall back to in-memory file snapshots

Recommendation: **(a)** for v1. Non-git directories are uncommon for
coding projects, and the in-memory fallback can't track bash modifications.
Display: `⚠ /rewind requires a git repository`.

### 3. How to handle .gitignore'd files

`git add -A` skips ignored files. If the agent modifies `.env` or
`node_modules/` files, they won't be in snapshots.

Options:
- **(a)** Accept the limitation (most ignored files shouldn't be rewound)
- **(b)** Use `git add -A --force` (captures everything but bloats .git)
- **(c)** Track ignored files separately in memory

Recommendation: **(a)** for v1. Agent modifications to `.env` or
`node_modules` are rare and usually intentional.

### 4. Clean untracked files on rewind

`git clean -fd` removes ALL untracked files, including ones that existed
before the session. Mitigation: record the set of untracked files at
session start. On rewind, only `git clean` files NOT in that set.

Implementation: `git clean -fd --exclude=<file>` for each baseline
untracked file. Or: run `git clean -n -fd` to get the list, filter
against baseline set, then remove manually.

### 5. Cleanup on abnormal exit

If tallow crashes, snapshot commits remain in git history. This is
visible but harmless — the user can `git reset --soft HEAD~N` to
remove them. Consider adding cleanup detection on next session start:
scan for commits with `tallow:snapshot:` prefix and offer to clean up.
