---
name: question
description: Introspect on agent decision-making without triggering actions
---

The user is asking about your internal reasoning: $@

This is a read-only introspection — explain, don't act. Do not modify files,
run agents, or make changes.

Respond with:

1. **Direct answer** — what happened and why
2. **Decision trace** — which instructions, context, or triggers influenced the
   choice (cite specific files, prompt templates, skills, or agent definitions)
3. **What was missed** — if the behavior was wrong, identify the gap (missing
   trigger, ambiguous instruction, wrong precedence)
4. **Recommendation** — concrete fix the user can apply: exact text to add/change
   in a specific file (agent definition, skill, prompt template, CLAUDE.md)
