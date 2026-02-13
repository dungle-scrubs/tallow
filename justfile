# Tallow — an opinionated coding agent built on pi
# Run `just` to see all available recipes

default:
    @just --list

# ── Build ────────────────────────────────────────

# Build everything (tallow-tui fork → core)
build:
    npm run build

# Build tallow-tui fork only
build-tui:
    cd packages/tallow-tui && npm run build

# Watch mode (core only — does NOT watch tallow-tui)
dev:
    npm run dev

# ── Code Quality ─────────────────────────────────

# Typecheck core + extensions + lint (same as pre-commit)
check: typecheck typecheck-ext lint

# Typecheck core
typecheck:
    npm run typecheck

# Typecheck extensions (separate tsconfig)
typecheck-ext:
    npm run typecheck:extensions

# Lint + format check
lint:
    npm run lint

# Auto-fix lint + format
fix:
    npm run lint:fix

# Format only
format:
    npm run format

# Format check (no write)
format-check:
    npm run format:check

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
    cd docs && npm run dev

# Build docs site
docs-build:
    cd docs && npm run build

# Preview docs build
docs-preview:
    cd docs && npm run preview

# ── Cleanup ──────────────────────────────────────

# Remove build artifacts
clean:
    rm -rf dist packages/tallow-tui/dist
