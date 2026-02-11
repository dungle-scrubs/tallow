---
name: fix
description: Diagnose and fix errors in the project
---

The project has errors. Diagnose and fix them:

1. Check for build/compilation errors (`npm run build`, `tsc`, etc.)
2. Check for test failures
3. Check for lint errors
4. Read error messages carefully — trace to root cause
5. Fix the issues, starting with the most fundamental (type errors before lint)
6. Verify each fix by re-running the failing command
7. If a fix creates new issues, address those too

Don't just suppress errors — understand and fix the root cause.
