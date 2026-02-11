---
name: review
description: Review the current codebase for issues, bugs, and improvements
---

Review the code in the current directory. Focus on:

1. **Bugs** — logic errors, edge cases, off-by-one errors
2. **Security** — injection, auth issues, secrets in code
3. **Performance** — N+1 queries, unnecessary allocations, blocking calls
4. **Maintainability** — dead code, unclear naming, missing types

Start by reading the project structure, then examine the most critical files.
Present findings as a prioritized list with file paths and line numbers.
