---
description: Guide project structure and database selection for new projects
---

# Project Scaffold

Invoke the `project-scaffold` skill to guide the user through project structure and database selection decisions.

Walk through the decision trees interactively:
1. Ask about languages involved (TypeScript, Python, or both)
2. Ask about components needed (CLI, web app, API, database)
3. Guide database selection based on requirements
4. Recommend the appropriate project shape
5. Provide the directory structure template

Do not assume answers - ask the user for each decision point.
