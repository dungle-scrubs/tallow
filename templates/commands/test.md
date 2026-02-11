---
name: test
description: Analyze the project and write missing tests
---

Analyze the project in the current directory:

1. Identify the test framework in use (or recommend one if none exists)
2. Find code that lacks test coverage — focus on business logic, edge cases, and error paths
3. Write the tests, prioritizing:
   - Functions with complex branching
   - Error handling paths
   - Integration points (API calls, database, file I/O)
   - Recently changed files (check git log)

Run the tests after writing them to verify they pass.
