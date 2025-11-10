# Changelog

## [Unreleased]

_No changes yet._

## [0.4.4] - 2025-11-10

### CLI & runtime
- Fixed the npm `bin` entry so it points to `dist/cli.js` without a leading `./`, keeping the executable in the published tarball and restoring `npx mcporter` functionality. Also bumped the embedded runtime version to 0.4.4 so the CLI reports the correct release.

### Docs
- Consolidated the external MCP import matrix into `docs/import.md`, removing the short-lived `docs/mcp-import.md` duplication, and clarified the release checklist to stop immediately on failing tests or lint warnings.

## [0.4.3] - 2025-11-10

### CLI & runtime
- Added OpenCode imports (project `opencode.json[c]`, `OPENCODE_CONFIG_DIR`, user config, and the `OPENCODE_CONFIG` override) plus JSONC parsing so `mcporter list/config` can auto-discover servers defined in OpenCode.
- Claude Code imports now honor `.claude/settings.local.json` and `.claude/settings.json` ahead of the legacy `mcp.json`, and we skip entries that lack a URL/command (e.g., permissions blocks) so malformed settings no longer break the merge.

### Docs
- Documented the full import matrix (including OpenCode + Claude settings hierarchy) directly in `docs/import.md` and `docs/config.md`.

## [0.4.2] - 2025-11-09

### CLI & runtime
- `mcporter list` (and other commands that load imports) now skip empty or malformed Claude Desktop / Cursor / Codex config files instead of throwing, so a blank `claude_desktop_config.json` no longer blocks the rest of the imports.
- Bundled sample config adds the Mobile Next MCP definition, making it available out of the box when you run `mcporter list` before customizing your own config.

## [0.4.1] - 2025-11-08

### CLI & runtime
- Fixed the fallback when `config/mcporter.json` is missing so `mcporter list` continues to import Cursor/Claude/Codex/etc. configs even when you run the CLI outside a repo that defines its own config, matching the 0.3.x behavior.
- Added regression coverage that exercises the “no config file” path to ensure future changes keep importing user-level MCP servers.

## [0.4.0] - 2025-11-08

### CLI & runtime
- `mcporter config list` now displays only local entries by default, appends a color-aware summary of every imported config (path, counts, sample names), and still lets you pass `--source import`/`--json` for the merged view.
- `mcporter config get`, `remove`, and `logout` now use the same fuzzy matching/suggestion logic as `mcporter list`/`call`, auto-correcting near-miss names and emitting “Did you mean …?” hints when ambiguity remains.

## [0.3.6] - 2025-11-08

### CLI & runtime
- `mcporter list` now prints copy/pasteable examples for ad-hoc servers by repeating the HTTP URL (with quoting) so the commands shown under `Examples:` actually work before you persist the definition.

### Code generation
- Staged the actual dependency directories (`commander`, `mcporter`) directly into the Bun bundler workspace so `npx mcporter generate-cli "npx -y chrome-devtools-mcp" --compile` succeeds even when npm hoists dependencies outside the package (fixes the regression some users still saw with 0.3.5).

## [0.3.5] - 2025-11-08

### Code generation
- Ensure the Bun bundler resolves `commander`/`mcporter` even when `npx mcporter generate-cli … --compile` runs inside an empty temp directory by symlinking mcporter’s own `node_modules` into the staging workspace before invoking `bun build`. This keeps the “one weird trick” workflow working post-0.3.4 without requiring extra installs.

## [0.3.4] - 2025-11-08

### CLI & runtime
- Added a global `--oauth-timeout <ms>` flag (and the matching `MCPORTER_OAUTH_TIMEOUT_MS` override) so long-running OAuth handshakes can be shortened during debugging; the runtime now logs a clear warning and tears down the flow once the limit is reached, ensuring `mcporter list/call/auth` always exit.

### Docs
- Documented the new OAuth timeout flag/env var across the README and tmux/hang-debug guides so release checklists and manual repro steps call out the faster escape hatch.

## [0.3.3] - 2025-11-07

### Code generation
- When a server definition omits `description`, `mcporter generate-cli` now asks the MCP server for its own `instructions`/`serverInfo.title` during tool discovery and embeds that value, so generated CLIs introduce themselves with the real server description instead of the generic “Standalone CLI…” fallback.
- Embedded tool listings inside generated CLIs now show each command’s flag signature (no `usage:` prefix) separated by blank lines, and per-command `--help` output inherits the same colorized usage/option styling as the main `mcporter` binary for readability on rich TTYs.
- Added a `--bundler rolldown|bun` flag to `mcporter generate-cli`, defaulting to Rolldown but allowing Bun’s bundler (when paired with `--runtime bun`) for teams that want to stay entirely inside the Bun toolchain. The generator now records the chosen bundler in artifact metadata and enforces the Bun-only constraint so reproduction via `--from` stays deterministic.
- When Bun is installed (and therefore selected as the runtime), `mcporter generate-cli` now automatically switches the bundler to Bun as well—no need to pass `--bundler bun` manually—while keeping Rolldown as the default for Node runtimes.
- Bundling with Bun copies the generated template into mcporter’s install tree before invoking `bun build`, ensuring local `commander`/`mcporter` dependencies resolve even when the user runs the generator from an empty temp directory.

## [0.3.2] - 2025-11-07

### CLI
- Embedded the CLI version so Homebrew/Bun builds respond to `mcporter --version` even when `package.json` is unavailable.
- Revamped `mcporter --help` to mirror the richer list/call formatting (name + summary rows, grouped sections, quick-start examples, and ANSI colors when TTYs are detected).
- Fixed `mcporter list` so it no longer errors when `config/mcporter.json` is absent—fresh installs now run without creating config files, and a regression test guards the optional-config flow.
- Generated standalone CLIs now print the full help menu (same grouped layout as the main CLI) when invoked without arguments, matching the behavior of `mcporter` itself.

### Code generation
- Generated binaries now default to the current working directory (using the inferred server name) when `--compile` is provided without a path, and automatically append a numeric suffix when the target already exists.
- Standalone CLIs inherit the improved help layout (color-aware title, grouped command summaries, embedded tool listings, and quick-start snippets) so generated artifacts read the same way as the main CLI.
- Swapped the bundler from esbuild to Rolldown for both JS and Bun targets, removing the fragile per-architecture esbuild binaries while keeping aliasing for local dependencies and honoring `--minify` via Rolldown’s native minifier.
- Improved `generate-cli` so inline stdio commands (e.g., `"npx chrome-devtools-mcp"`) parse correctly even when invoked from empty directories.

### Code generation
- `readPackageMetadata()` now tolerates missing `package.json` files; when invoked from a directory without a manifest it falls back to mcporter’s own version string, so `generate-cli` works even when you call it via `npx` in an empty folder.

## [0.3.1] - 2025-11-07

### CLI & runtime
- Short-circuited global `--help` / `--version` handling so these flags no longer fall through command inference and always print immediately, regardless of which command the user typed first.
- Added regression coverage for the new shortcuts and kept the existing `runCli` helper exported so tests (and downstream tools) can exercise argument parsing without forking the entire process.

### Code generation & metadata
- Fixed `mcporter generate-cli --bundle/--compile` in empty directories by aliasing `commander`/`mcporter` imports to the CLI’s own installation so esbuild always resolves dependencies. Verified with a new fixture that bundles from temp dirs without `node_modules` (fixes #1).
- Added an end-to-end integration test that runs `node dist/cli.js generate-cli` twice—once for bundling and once for `--compile`—as well as a GitHub Actions step that installs Bun so CI exercises the compiled binary path on every PR.


## [0.3.0] - 2025-11-06

### CLI & runtime
- Added configurable log levels (`--log-level` / `MCPORTER_LOG_LEVEL`) that default to `warn`, promoting noisy transport fallbacks to warnings so critical issues still surface.
- Forced the CLI to exit cleanly after shutdown (opt out with `MCPORTER_NO_FORCE_EXIT`) and patched `StdioClientTransport` so stdio MCP servers no longer leave Node handles hanging; stderr from stdio servers is buffered and replayed via `MCPORTER_STDIO_LOGS=1` or whenever a server exits with a non-zero status.

### Discovery, calling, and ad-hoc workflows
- Rebuilt `mcporter list`: spinner updates stream live, summaries print only after discovery completes, and single-server views now render TypeScript-style doc blocks, inline examples, inferred return hints, and compact `// optional (N): …` summaries. The CLI guarantees at least five parameters before truncating, introduced a single `--all-parameters` switch (replacing the `--required-only` / `--include-optional` pair), and shares its formatter with `mcporter generate-cli` so signatures are consistent everywhere.
- Verb inference and parser upgrades let bare server names dispatch to `list`, dotted invocations jump straight to `call`, colon-delimited flags (`key:value` / `key: value`) sit alongside `key=value`, and the JavaScript-like call syntax now supports unlabeled positional arguments plus typo correction heuristics when tool names are close but not exact.
- Ad-hoc workflows are significantly safer: `--http-url` / `--stdio` definitions (with `--env`, `--cwd`, `--name`, `--persist`) work across `list`, `call`, and `auth`, mcporter reuses existing config entries when a URL matches (preserving OAuth tokens / redirect URIs), and `mcporter auth <url>` piggybacks on the same resolver to persist entries or retry when a server flips modes mid-flight.
- Hardened OAuth detection automatically promotes ad-hoc HTTP servers that return 401/403 to `auth: "oauth"`, broadens the unauthorized heuristic for Supabase/Vercel/GitHub-style responses, and performs a one-time retry whenever a server switches into OAuth mode while you are connecting.

### Code generation & metadata
- Generated CLIs now embed their metadata (generator version, resolved server definition, invocation flags) behind a hidden `__mcporter_inspect` command. `mcporter inspect-cli` / `mcporter generate-cli --from <artifact>` read directly from the artifact, while legacy `.metadata.json` sidecars remain as a fallback for older binaries.
- Shared the TypeScript signature formatter between `mcporter list` and `mcporter generate-cli`, ensuring command summaries, CLI hints, and generator help stay pixel-perfect and are backed by new snapshot/unit tests.
- Introduced `mcporter emit-ts`, a codegen command that emits `.d.ts` tool interfaces or ready-to-run client wrappers (`--mode types|client`, `--include-optional`) using the same doc/comment data that powers the CLI, so agents/tests can consume MCP servers with strong TypeScript types.
- `mcporter generate-cli` now accepts inline stdio commands via `--command "npx -y package@latest"` or by quoting the command as the first positional argument, automatically splits the command/args, infers a friendly name from scripts or package scopes, and documents the chrome-devtools one-liner in the README; additional unit tests cover HTTP, stdio, scoped package, and positional shorthand flows.

### Documentation & references
- Added `docs/tool-calling.md`, `docs/call-syntax.md`, and `docs/call-heuristic.md` to capture every invocation style (flags, function expressions, inferred verbs) plus the typo-correction rules.
- Expanded the ad-hoc/OAuth story across `README.md`, `docs/adhoc.md`, `docs/local.md`, `docs/known-issues.md`, and `docs/supabase-auth-issue.md`, detailing when servers auto-promote to OAuth, how retries behave, and how to persist generated definitions safely.
- Updated the README, CLI reference, and generator docs to cover the new `--all-parameters` flag, list formatter, metadata embedding, the `mcporter emit-ts` workflow, and refreshed branding so the CLI and docs consistently introduce the project as **MCPorter**.
- Tightened `RELEASE.md` with a zero-warning policy so `pnpm check`, `pnpm test`, `npm pack --dry-run`, and friends must run clean before publishing.

## [0.2.0] - 2025-11-06

- Added non-blocking `mcporter list` output with per-server status and parallel discovery.
- Introduced `mcporter auth <server>` helper (and library API support) so OAuth flows don’t hang list calls.
- Set the default list timeout to 30 s (configurable via `MCPORTER_LIST_TIMEOUT`).
- Tuned runtime connection handling to avoid launching OAuth flows when auto-authorization is disabled and to reuse cached clients safely.
- Added `mcporter auth <server> --reset` to wipe cached credentials before rerunning OAuth.
- `mcporter list` now prints `[source: …]` (and `Source:` in single-server mode) for servers imported from other configs so you can see whether an entry came from Cursor, Claude, etc.
- Added a `--timeout <ms>` flag to `mcporter list` to override the per-server discovery timeout without touching environment variables.

- Generated CLIs now show full command signatures in help and support `--compile` without leaving template/bundle intermediates.
- StdIO-backed MCP servers now receive resolved environment overrides, so API keys flow through to launched processes like `obsidian-mcp-server`.
- Hardened the CLI generator to surface enum defaults/metadata and added regression tests around the new helper utilities.
- Generated artifacts now emit `<artifact>.metadata.json` files plus `mcporter inspect-cli` / `mcporter regenerate-cli` workflows (with `--dry-run` and overrides, now handled via `generate-cli --from <artifact>`) so binaries can be refreshed after upgrading mcporter.
- Fixed `mcporter call <server> <tool>` so the second positional is treated as the tool name instead of triggering the "Argument must be key=value" error, accepted `tool=`/`command=` selectors now play nicely with additional key=value payloads, and added a default call timeout (configurable via `MCPORTER_CALL_TIMEOUT` or `--timeout`) that tears down the MCP transport—clearing internal timers and ignoring blank env overrides—so long-running or completed tools can’t leave the CLI hanging open.

## [0.1.0]

- Initial release.
