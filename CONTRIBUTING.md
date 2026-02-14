# Contributing

## Development setup

```bash
git clone https://github.com/dungle-scrubs/tallow.git
cd tallow
bun install
bun run build
```

## Making changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run checks:
   ```bash
   bun run typecheck
   bun run typecheck:extensions
   bun run lint
   bun test
   bun run build
   ```
5. Commit using [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, etc.)
6. Push and open a Pull Request

## Project structure

```
src/              Core source — CLI, SDK, config
extensions/       Bundled extensions (each is a directory with index.ts + extension.json)
commands/         Slash command templates (markdown)
agents/           Specialized agent definitions (markdown)
themes/           Terminal color themes (JSON)
docs/             Documentation site (Astro + Starlight)
tests/            E2E tests
```

## Code style

- **Biome** handles linting and formatting — run `bun run lint:fix` to auto-fix
- Indent with tabs, line width 100
- Semicolons, double quotes, ES5 trailing commas
- All functions require JSDoc comments explaining *why*, not *what*

## Writing extensions

Each extension lives in `extensions/<name>/` with:
- `extension.json` — metadata (name, description, version)
- `index.ts` — default export function receiving `ExtensionAPI`

## Tests

Tests use `bun:test`. Run with:

```bash
bun test                          # All tests
bun test extensions/hooks         # Specific extension
```
