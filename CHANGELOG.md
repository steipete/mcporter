# mcporter Changelog

## [Unreleased]

### CLI
- Coerce generated CLI array arguments based on JSON Schema item types (including integer arrays).

### Tests
- Added regression coverage for typed array parsing in generated CLIs.

## [0.7.2] - 2025-12-29
### CLI
- Fixed generated CLIs to read Commander.js option values via camelCased properties so snake_case tool schemas map correctly.

### Tests
- Added regression coverage for snake_case, camelCase, and numeric option names in generated CLIs.
- Increased the Bun bundler integration-test timeout to reduce flakes on slower runners.

### Tooling / Dependencies
- Updated dependency set (SDK, Rolldown, Zod, Biome, Oxlint, Bun types).
- Synced the Biome schema URL to the current CLI version.

## [0.7.1] - 2025-12-08
### Daemon
- Track config file mtimes for every loaded layer (home + project or explicit) in daemon metadata and auto-restart when any layer changes, so newly added keep-alive servers are picked up without manual restarts. Includes regression tests for stale-daemon detection.

## [0.7.0] - 2025-12-06
### CLI
- Centralized OAuth credentials in a shared vault (`~/.mcporter/credentials.json`) while still honoring per-server `tokenCacheDir` when present; legacy per-server caches are migrated automatically.
- `mcporter auth --reset` now clears the vault and legacy caches without crashing on corrupted credential files, making re-auth reliable for servers like Gmail.
- StdIO servers that expose a separate auth subcommand (e.g., Gmail MCP) can now declare `oauthCommand.args`; `mcporter auth <server>` will spawn that helper and wait for browser completion, so Gmail auth now works without running npx manually.
- Raw output now prints full strings without Node’s 10k-character truncation (`util.inspect` uses `maxStringLength: null`), so large MCP responses and plans are preserved end-to-end.
- Added regression coverage to ensure future raw output changes cannot reintroduce truncation.

## [0.6.6] - 2025-11-28
### CLI
- Prevented ENOENT crashes when no config file exists anywhere by only passing an explicit `--config`/`MCPORTER_CONFIG` path to the runtime; implicit defaults now fall back cleanly across list/config/daemon flows.

## [0.6.5] - 2025-11-26
### CLI
- `mcporter call|auth|list help/--help` now print the command-specific usage text instead of attempting to run a server, matching the footer’s “mcporter <command> --help” hint.
- Added a hidden `list-tools` alias for `mcporter list` to preserve older muscle memory and avoid “Unknown MCP server” errors when copied from legacy docs.
- Ad-hoc HTTP flows now accept `--insecure` as a hidden synonym for `--allow-http`, making plain-HTTP testing flags match common intuition. `--sse` also aliases `--http-url` to keep older examples working.
### Security / Dependencies
- Override transitive `body-parser` to 2.2.1 (CVE-2025-13466) via pnpm overrides.

## [0.6.4] - 2025-11-25
### CLI
- `mcporter list` now uses cached OAuth access tokens (if present) for the all-servers view without opening browser windows, so previously authorized servers no longer show spurious “auth required” in non-interactive listings.
- `pnpm test --filter <pattern>` now works by translating to a Vitest file pattern, avoiding the prior “Unknown option --filter” error.

## [0.6.3] - 2025-11-22
### Runtime & CLI
- Updated to `@modelcontextprotocol/sdk` 1.22.0; inline stdio test server now uses Zod schemas to remain compatible with the SDK’s JSON Schema conversion path.

### Runtime
- `listTools` now follows SDK pagination, looping through `nextCursor` so long catalogs return complete tool lists.

### Configuration
- Claude imports now preserve root-fallback parsing for legacy `.claude.json` and `.claude/mcp.json` files while treating `.claude/settings*.json` as container-only configs, preventing metadata fields like `statusLine` from being misdetected as MCP servers.
- Added regression coverage for Claude settings and mcp.json imports to guard the root-fallback behavior.

## [0.6.2] - 2025-11-18

### Runtime
- Propagate `--timeout` / `MCPORTER_CALL_TIMEOUT` into MCP tool calls (SDK `timeout`, `resetTimeoutOnProgress`, `maxTotalTimeout`) so long-running requests are no longer capped by the SDK’s 60s default.

### CLI
- `mcporter generate-cli` once again treats single-token `--command` values (e.g., `./scripts/server.ts`) as STDIO transports instead of trying to coerce them into HTTP URLs, restoring the pre-0.6.1 behavior for ad-hoc scripts.
- Global flag parsing moved into `cli-factory` for consistent log-level/oauth-timeout handling across commands.
- `daemon` host/client hardened and covered with new tests; idle eviction and restart paths verified.

### Configuration
- Reintroduced support for `OPENCODE_CONFIG_DIR` so OpenCode imports continue to honor the documented directory override alongside `OPENCODE_CONFIG`.
- Platform-aware defaults for Cursor/Claude/Windsurf/VS Code/OpenCode configs now dedupe paths and include Windows-specific locations.

### Platform resilience (Windows/WSL)
- Added `fs-helpers` that treat chmod/copy failures on NTFS/DrvFs as best-effort so CLI generation keeps working on WSL mounts.
- Documented Windows/WSL workflows: install/test from ext4 copies, remount guidance for /mnt/c, and syncing tips.

### StdIO MCP coverage
- Added stdio e2e tests using in-repo filesystem & memory MCP fixtures to ensure list/call works via execPath.

### Content extraction
- `createCallResult` now reads nested `raw.content`/`raw.structuredContent` so tools that wrap responses render text/markdown/json correctly; new unit tests cover text joining, markdown, and JSON.

## [0.6.1] - 2025-11-17

### CLI
- `mcporter list --verbose` now surfaces every config path that registers the target server (primary first, then duplicates) in both text and JSON output, making it easier to trace where a name is coming from.
- JSON list payloads include a new `sources` array when `--verbose` is set, mirroring the on-screen path list for programmatic consumers.
- Verbose source listings now tag the import kind (cursor/vscode/codex, etc.) and explicitly label the primary entry vs. shadowed duplicates.

### Runtime
## [0.6.0] - 2025-11-16

### Configuration
- Default config resolution now layers the system config (`~/.mcporter/mcporter.json[c]`) before the project config (`config/mcporter.json`), so globally installed MCP servers remain available inside repos while allowing per-project overrides.
- `--config` and `MCPORTER_CONFIG` continue to select a single file without merging for explicit workflows.
- `mcporter config add --scope home|project` lets you choose the write target explicitly (project remains the default; `--persist <path>` still wins when provided).

## [0.5.11] - 2025-11-16

### Code generation & metadata
- Quick start examples in generated CLIs now derive from actual embedded tools (up to three), showing real command names/flags instead of generic placeholders.

## [0.5.10] - 2025-11-16

### Code generation & metadata
- Generated CLIs now present the canonical kebab-cased tool names in help while accepting underscore aliases at runtime, eliminating the “unknown command” errors when copying names directly from server tool lists.

## [0.5.9] - 2025-11-15

### CLI
- `mcporter list` suppresses raw STDIO stderr dumps when enumerating all configured servers, keeping the summary output readable while still surfacing per-server health statuses.
- `mcporter config <subcommand> --help` (and `mcporter config help <subcommand>`) now display detailed usage, flags, and examples for every config subcommand instead of returning a placeholder message. Inline `--help` tokens are intercepted before executing the command, so flows like `mcporter config add --help` no longer throw usage errors.
- `mcporter config doctor` prints the project and system config paths before reporting diagnostics, making it obvious which files were inspected when tracking down configuration issues.

## [0.5.8] - 2025-11-15

### CLI & runtime
- STDIO transports now interpolate `${VAR}`/`$env:VAR` tokens in the configured command and arguments before spawning child processes, so chrome-devtools inherits the live `CHROME_DEVTOOLS_URL` value instead of receiving the literal placeholder.
- Keep-alive detection skips any STDIO server whose command/args reference `CHROME_DEVTOOLS_URL`, ensuring daemon mode relaunches chrome-devtools for each Oracle browser session instead of pinning a stale port.
- Command arguments that escape placeholders as `\${VAR}` (common when using `String.raw` in TypeScript config helpers) now trim the backslash after interpolation so downstream servers receive clean URLs.

### CLI
- Ad-hoc STDIO invocations that start with `npx -y <package>` now infer the npm package name (stripping versions and ignoring arguments after `--`) instead of producing slugs like `npx-y`, so repeated `mcporter list|call` runs automatically reuse a readable server key without passing `--name`.
- Quoted inline commands such as `mcporter list "npx -y xcodebuildmcp"` now auto-detect the ad-hoc STDIO transport, so you can skip `--stdio` entirely when probing MCP packages via `npx`.

## [0.5.7] - 2025-11-14

### CLI
- Added `mcporter daemon restart`, a stop+start convenience that reuses logging flags so agents can bounce the keep-alive daemon with a single command.
- Added `list_tools` as a hidden shortcut for `mcporter list <server>`, so `chrome-devtools.list_tools` (and similar selectors) print the tool catalog instantly without requiring a real MCP tool.
- Warn when colon-style arguments omit a value (e.g., `command:`) and suggest quoting/`--args` JSON so agents don’t accidentally send `undefined` to STDIO servers.

## [0.5.6] - 2025-11-11

### CLI & runtime
- Reset cached keep-alive connections whenever STDIO transports hit fatal errors (timeouts, closed pipes, daemon restarts, etc.), so chrome-devtools automatically recovers after you close Chrome instead of requiring `mcporter daemon stop`.
- Daemon-routed calls now log a restart notice and automatically retry once after closing the stale transport, providing self-healing behavior when Chrome or other keep-alive servers crash mid-call.

## [0.5.5] - 2025-11-11

### CLI & runtime
- Added hidden agent shortcuts: `mcporter describe <server>` now aliases `mcporter list`, and calling `<server>.help` automatically falls back to the list output when a server lacks a `help` tool (also wired into the legacy `pnpm mcp call` path) so agents always get a readable summary.

## [0.5.4] - 2025-11-10

### CLI & runtime
- Propagate the CLI’s per-call timeout (defaults to 60s or `--timeout`) through the keep-alive daemon, so chrome-devtools and other persistent STDIO servers stop as soon as the caller times out.
- `Runtime.callTool` now honors `timeoutMs` directly, ensuring TanStack MCP clients and the CLI share a single source of truth for cancellation even outside the daemon.
- Ad-hoc STDIO servers launched via `mcporter call "npx …"` (or `--stdio`) inherit the same keep-alive heuristics and canonical names as config-defined entries, so `MCPORTER_DISABLE_KEEPALIVE=chrome-devtools` and similar overrides work without passing `--name`.

### Tests
- Added regression coverage (`tests/daemon-client-timeout.test.ts`, `tests/runtime-call-timeout.test.ts`, and updated keep-alive suites) to guard timeout propagation and canonical keep-alive detection.

## [0.5.3] - 2025-11-10

### CLI & runtime
- Fixed Claude imports so `mcporter list` merges project-scoped servers from `.claude.json` (matching the current workspace) and ignores metadata-only keys like `tipsHistory`/`cachedStatsigGates`, resolving GitHub issues #6 and #7.
- OpenCode imports now read only the documented `mcp` container (no root-level fallback), matching the current OpenCode schema and preventing stray metadata from being misinterpreted as servers.

## [0.5.2] - 2025-11-10

### CLI & runtime
- `mcporter call "<stdio command>" ...` now auto-detects ad-hoc STDIO servers, so you can skip `--stdio/--stdio-arg` entirely and just quote the command you want to run.
- When a server exposes exactly one tool, `mcporter call` infers it automatically (and prints a dim log), letting one-tool servers like Vercel Domains run with only their arguments.
- STDIO transports now inherit your current shell environment by default, so ad-hoc commands see the same variables as your terminal; keep `--env KEY=value` for explicit overrides.

### Fixes
- `mcporter config list` and `mcporter config doctor` no longer crash when the project config is missing or contains malformed JSON; we log a single warning and keep going, matching the behavior of the top-level `mcporter list`.

## [0.5.1] - 2025-11-10

### CLI & runtime
- Added a per-login daemon that auto-starts when keep-alive MCP servers (e.g., Chrome DevTools, Mobile MCP, Playwright) are invoked. The daemon keeps STDIO transports alive across agents, exposes `mcporter daemon <start|status|stop>`, and supports idle shutdown plus manual restarts.
- Keep-alive detection now honors the `lifecycle` config flag/env overrides and also inspects STDIO command signatures, so renaming `chrome-devtools` (or other stateful servers) no longer disables the daemon accidentally.
- Introduced daemon logging controls (`mcporter daemon start --log|--log-file`, `--log-servers`, `MCPORTER_DAEMON_LOG*` env vars, and per-server `logging.daemon.enabled`). `mcporter daemon status` reports the active log path, and a new `tests/daemon.integration.test.ts` suite keeps the end-to-end flow covered.

### Fixes
- `mcporter list` (and every CLI entry point) once again treats missing project configs as empty instead of throwing ENOENT, matching the 0.4.x behavior when you run the CLI outside a repo.

## [0.5.0] - 2025-11-10

### CLI & runtime
- **Daemonized keep-alive servers.** A new per-login daemon automatically spins up whenever keep-alive MCP servers (Chrome DevTools, Mobile MCP, Playwright, etc.) are invoked. It keeps STDIO transports warm across agents, exposes `mcporter daemon <start|status|stop>`, supports idle shutdowns/manual restarts, and respects the `lifecycle` config flag plus STDIO command metadata so renamed servers stay eligible.
- Fixed `createKeepAliveRuntime` so the daemon wrapper’s `listTools` implementation matches the base `Runtime` signature; `pnpm build` (and any command that shells out to `pnpm build`) succeeds again.
- Cursor imports now cover both workspace and user `.cursor/mcp.json` files plus the platform-specific `Cursor/User/mcp.json` directories, and the VS Code/Windsurf walkers dedupe paths so editor-managed MCP servers are auto-discovered consistently across macOS, Linux, and Windows.
- Windows installs now enumerate `.cursor/mcp.json`, `%USERPROFILE%\\.cursor\\mcp.json`, `%APPDATA%\\Cursor\\User\\mcp.json`, `.vscode/mcp.json`, and the Windsurf/Codeium directories automatically, while STDIO transports on Windows tear down entire process trees via `powershell.exe Get-CimInstance Win32_Process` to avoid orphaned child servers.

## [0.4.5] - 2025-11-10

### CLI & runtime
- Fixed the npm `bin` entry so it points to `dist/cli.js` without a leading `./`, keeping the executable in the published tarball and restoring `npx mcporter` functionality. Also bumped the embedded runtime version to 0.4.4 so the CLI reports the correct release.
- Added `MCPORTER_CONFIG` plus a home-directory fallback (`~/.mcporter/mcporter.json[c]`) so the CLI automatically finds your system-wide config when a project file is missing.

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
- Tightened `docs/RELEASE.md` with a zero-warning policy so `pnpm check`, `pnpm test`, `npm pack --dry-run`, and friends must run clean before publishing.

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
## [0.6.2] - 2025-11-18

### Platform resilience (Windows/WSL)
- Added `fs-helpers` that treat chmod/copy failures on NTFS/DrvFs as best-effort so CLI generation keeps working on WSL mounts.
- Documented Windows/WSL workflows: install/test from ext4 copies, remount guidance for /mnt/c, and syncing tips.

### CLI/runtime
- Global flag parsing moved into `cli-factory` for consistent log-level/oauth-timeout handling across commands.
- `daemon` host/client hardened and covered with new tests; idle eviction and restart paths verified.
- Imports now include platform-aware defaults for Cursor/Claude/Windsurf/VS Code/OpenCode configs with path dedupe.

### StdIO MCP coverage
- Added stdio e2e tests using in-repo filesystem & memory MCP fixtures to ensure list/call works via execPath.

### Content extraction
- `createCallResult` now reads nested `raw.content`/`raw.structuredContent` so tools that wrap responses render text/markdown/json correctly; new unit tests cover text joining, markdown, and JSON.

### Docs
- New `docs/windows.md` with WSL/NTFS tips; added to docs index.
