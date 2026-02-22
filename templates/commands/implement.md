---
description: Full implementation workflow - scout gathers context, planner creates plan, worker implements
---

Parse flags from `$@` before starting:

- If `--worktree` is present:
  1. Remove `--worktree` from the task text.
  2. Generate a concise branch name from the task (`feat/<name>` or `fix/<name>`).
  3. Create a new worktree from clean `HEAD`:
     - Derive `<branch-slug>` from `<branch-name>` by replacing `/` with `-`.
     - `git worktree add -b <branch-name> ../<repo-name>-<branch-slug> HEAD`
  4. If the current checkout is dirty, ignore those changes completely.
     - Do **not** stash, commit, or include them.
     - Continue implementation only inside the new worktree.
  5. If branch/path already exists, ask user whether to reuse, recreate, or abort.

Then use the subagent tool with the `centipede` parameter:

1. Use the `scout` agent to find all code relevant to the cleaned task text.
2. Use the `planner` agent to create an implementation plan for that task using `{previous}`.
3. Use the `worker` agent to implement the plan from `{previous}`.

If `--worktree` was passed, set `cwd` for all centipede steps to the new worktree path.

Execute as a centipede, passing outputs between steps via `{previous}`.
