#!/usr/bin/env bash
set -euo pipefail

# Pre-PR validation: mirror CI checks locally before opening a PR.

echo "==> Lockfile guardrail"
bad_lockfiles="$(git ls-files | rg -E '(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn.lock)$' || true)"
if [[ -n "${bad_lockfiles}" ]]; then
	echo "ERROR: Non-Bun lockfiles are tracked in git:"
	echo "${bad_lockfiles}"
	exit 1
fi

echo "==> Install dependencies (frozen lockfile)"
bun install --frozen-lockfile

echo "==> Audit dependencies (fail on critical)"
audit_output="$(bun audit 2>&1 || true)"
echo "${audit_output}"
if echo "${audit_output}" | rg -q "critical:"; then
	echo "ERROR: Critical vulnerability found by bun audit"
	exit 1
fi

echo "==> Build tallow-tui fork"
(
	cd packages/tallow-tui
	bun run build
)

echo "==> Typecheck (core + extensions)"
bun run typecheck
bun run typecheck:extensions

echo "==> Lint"
bunx biome ci .

echo "==> Build"
bun run build

echo "==> Test setup"
mkdir -p "${HOME}/.tallow/run"
# Avoid relying on global git config during tests that invoke git.
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-pre-pr}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-pre-pr@local.test}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-pre-pr}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-pre-pr@local.test}"

echo "==> Unit tests"
bun test

echo "==> Docs drift check"
node tests/docs-drift.mjs

echo "✅ Pre-PR checks passed"
