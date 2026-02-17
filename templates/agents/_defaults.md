---
# _defaults.md — Global defaults for all subagents
#
# Place this file in ~/.tallow/agents/ or .tallow/agents/ (project-local).
# Values here apply when neither the per-call params nor the agent's own
# frontmatter specify a value. Project _defaults.md overrides user _defaults.md.
#
# ─── Available Properties ────────────────────────────────────────────────
#
# tools: <comma-separated list>
#   Restrict which tools subagents can use by default.
#   Built-in tools: read, bash, edit, write, grep, find, ls
#   Default (when omitted): all built-in tools
#
# disallowedTools: <comma-separated list>
#   Block specific tools. Applied after the tools allowlist.
#   Example: disallowedTools: bash, write
#
# maxTurns: <number>
#   Maximum conversation turns before the subagent is stopped.
#   Default: no limit (runs until task is complete)
#
# mcpServers: <comma-separated list>
#   MCP server names to make available (must be configured in settings).
#
# missingAgentBehavior: match-or-ephemeral | error
#   What happens when a subagent call references a name that doesn't match
#   any agent file. "match-or-ephemeral" (default) fuzzy-matches or creates
#   a temporary agent. "error" rejects the call.
#
# fallbackAgent: <agent-name>
#   Agent to use when no match is found (instead of ephemeral).
#   Only applies when missingAgentBehavior is "match-or-ephemeral".
#
# ─── Agent Frontmatter Reference ─────────────────────────────────────────
#
# Individual agent .md files support these frontmatter properties:
#
#   name: <string>              (required) Agent identifier
#   description: <string>       (required) Shown in agent selection UI
#   tools: <comma-separated>    Tool allowlist (overrides _defaults.md)
#   disallowedTools: <comma>    Tool denylist (overrides _defaults.md)
#   skills: <comma-separated>   Skills to load (e.g. git, typescript-standards)
#   maxTurns: <number>          Turn limit for this agent
#   model: <string>             Model to use (e.g. claude-sonnet-4-5, auto-cheap)
#   mcpServers: <comma>         MCP servers to make available
#
# The body (below the --- frontmatter) becomes the agent's system prompt.
#
# ─── Example ─────────────────────────────────────────────────────────────
#
# To set conservative defaults for all agents:
#
#   maxTurns: 20
#   disallowedTools: write
#   missingAgentBehavior: error
#
---
