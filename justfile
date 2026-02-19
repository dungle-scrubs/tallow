# Tallow — an opinionated coding agent built on pi
# Run `just` to see all available recipes

default:
    @just --list

# ── Build ────────────────────────────────────────

# Build everything (tallow-tui fork → core)
build:
    bun run build

# Build tallow-tui fork only
build-tui:
    cd packages/tallow-tui && bun run build

# Watch mode (core only — does NOT watch tallow-tui)
dev:
    bun run dev

# ── Code Quality ─────────────────────────────────

# Typecheck core + extensions + lint (same as pre-commit)
check: typecheck typecheck-ext lint

# Run the full pre-PR validation suite (mirrors CI)
pre-pr:
    bash scripts/pre-pr.sh

# Typecheck core
typecheck:
    bun run typecheck

# Typecheck extensions (separate tsconfig)
typecheck-ext:
    bun run typecheck:extensions

# Lint + format check
lint:
    bun run lint

# Auto-fix lint + format
fix:
    bun run lint:fix

# Format only
format:
    bun run format

# Format check (no write)
format-check:
    bun run format:check

# ── Test ─────────────────────────────────────────

# Run all tests
test:
    bun test

# Run tests for a specific extension
# Usage: just test-ext tasks
test-ext name:
    bun test extensions/{{ name }}

# Run integration tests
test-int:
    bun test extensions/__integration__

# E2E: verify all slash commands register
test-e2e:
    node tests/e2e-commands.mjs

# ── Run ──────────────────────────────────────────

# Run tallow interactively (from built dist)
run:
    bun dist/cli.js

# Alias for run
start: run

# Run tallow with a single-shot prompt
# Usage: just prompt "Fix the tests"
prompt msg:
    bun dist/cli.js -p "{{ msg }}"

# Run the interactive installer
install:
    bun dist/install.js

# ── Docs ──────────────────────────────────────────

# Dev server for docs site
docs-dev:
    cd docs && bun run dev

# Build docs site
docs-build:
    cd docs && bun run build

# Preview docs build
docs-preview:
    cd docs && bun run preview

# ── Cleanup ──────────────────────────────────────

# Remove build artifacts
clean:
    rm -rf dist packages/tallow-tui/dist
