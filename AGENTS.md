# Repository Guidelines

## Project Structure & Module Organization
- `src/`: TypeScript source for the runtime and CLI entry points (`cli.ts`, `runtime.ts`, etc.).
- `tests/`: Vitest suites mirroring runtime behaviors; integration specs live alongside unit tests.
- `docs/`: Reference material for MCP usage and server coordination.
- `dist/`: Generated build artifacts; never edit by hand.

## Build, Test, and Development Commands
- `pnpm build`: Emits compiled JS and type declarations via `tsc -p tsconfig.build.json`.
- `pnpm lint`: Runs Biome style checks, Oxlint+tsgolint rules, and a `tsgo --noEmit` type pass.
- `pnpm test`: Executes the full Vitest suite once.
- `pnpm dev`: Watches and incrementally rebuilds the library with TypeScript.
- `pnpm clean`: Removes `dist/` so you can verify fresh builds.
- `tmux new-session -- pnpm mcp:list`: Exercise the CLI in a resilient terminal; tmux makes it easy to spot stalls or hung servers.
- `gh run list --limit 1 --watch`: Stream CI status in real time; use `gh run view --log` on the returned run id to inspect failures quickly.

## Coding Style & Naming Conventions
- TypeScript files use 2-space indentation, modern ES module syntax, and `strict` compiler settings.
- Imports stay sorted logically; prefer relative paths within `src/`.
- Run `pnpm lint:biome` before committing to auto-fix formatting; `pnpm lint:oxlint` enforces additional TypeScript rules powered by tsgolint.
- Use descriptive function and symbol names (`createRuntime`, `StreamableHTTPServerTransport`) and favor `const` for bindings.

## Testing Guidelines
- Add unit tests under `tests/`; mirror filename (`runtime.test.ts`) against the module under test.
- Use Vitest’s `describe/it/expect` APIs; keep asynchronous tests `async` to match runtime usage.
- For integration scenarios, reuse the HTTP harness shown in `tests/runtime-integration.test.ts` and ensure transports close in `afterAll`.
- Validate new work with `pnpm test` and confirm `pnpm lint` stays green.

## Commit & Pull Request Guidelines
- Commits should be scoped and written in imperative mood (`Add tsgo lint gate`, `Fix runtime integration transport`).
- Reference related issues in the body (`Refs #123`) and describe observable behavior changes.
- Pull requests should summarize the change set, list verification steps (`pnpm lint`, `pnpm test`), and include screenshots or logs when CLI output changes.

## Security & Configuration Tips
- Keep secrets out of the repo; pass credentials via environment variables when exercising MCP servers.
- Local scripts under `scripts/` (e.g., `mcp_signoz_retry_patch.cjs`) are safe shims for Sweetistics workflows—review them before extending.
