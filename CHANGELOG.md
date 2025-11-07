# Changelog

## [Unreleased]

### CLI & runtime
- Added configurable log levels (`--log-level` / `MCPORTER_LOG_LEVEL`) that default to `warn`, promoting noisy transport fallbacks to warnings so critical issues still surface.
- Forced the CLI to exit cleanly after shutdown (opt out with `MCPORTER_NO_FORCE_EXIT`) and patched `StdioClientTransport` so stdio MCP servers no longer leave Node handles hanging; stderr from stdio servers is buffered and replayed via `MCPORTER_STDIO_LOGS=1` or whenever a server exits with a non-zero status.
- Documented the tmux workflow (`tmux new-session -- pnpm mcporter:list`) so long-running list/debug sessions remain observable when diagnosing hung transports.
- Known issue: `mcporter --help` / `mcporter --version` currently route through the command inference heuristic and treat `--help` as a server name. The fix (explicit global `--help/--version` handling) is tracked for the next release.

### Discovery, calling, and ad-hoc workflows
- Rebuilt `mcporter list`: spinner updates stream live, summaries print only after discovery completes, and single-server views now render TypeScript-style doc blocks, inline examples, inferred return hints, and compact `// optional (N): …` summaries. The CLI guarantees at least five parameters before truncating, introduced a single `--all-parameters` switch (replacing the `--required-only` / `--include-optional` pair), and shares its formatter with `mcporter generate-cli` so signatures are consistent everywhere.
- Verb inference and parser upgrades let bare server names dispatch to `list`, dotted invocations jump straight to `call`, colon-delimited flags (`key:value` / `key: value`) sit alongside `key=value`, and the JavaScript-like call syntax now supports unlabeled positional arguments plus typo correction heuristics when tool names are close but not exact.
- Ad-hoc workflows are significantly safer: `--http-url` / `--stdio` definitions (with `--env`, `--cwd`, `--name`, `--persist`) work across `list`, `call`, and `auth`, mcporter reuses existing config entries when a URL matches (preserving OAuth tokens / redirect URIs), and `mcporter auth <url>` piggybacks on the same resolver to persist entries or retry when a server flips modes mid-flight.
- Hardened OAuth detection automatically promotes ad-hoc HTTP servers that return 401/403 to `auth: "oauth"`, broadens the unauthorized heuristic for Supabase/Vercel/GitHub-style responses, and performs a one-time retry whenever a server switches into OAuth mode while you are connecting.

### Code generation & metadata
- Generated CLIs now embed their metadata (generator version, resolved server definition, invocation flags) behind a hidden `__mcporter_inspect` command. `mcporter inspect-cli` / `mcporter generate-cli --from <artifact>` read directly from the artifact, while legacy `.metadata.json` sidecars remain as a fallback for older binaries.
- Shared the TypeScript signature formatter between `mcporter list` and `mcporter generate-cli`, ensuring command summaries, CLI hints, and generator help stay pixel-perfect and are backed by new snapshot/unit tests.
- Introduced `mcporter emit-ts`, a codegen command that emits `.d.ts` tool interfaces or ready-to-run client wrappers (`--mode types|client`, `--include-optional`) using the same doc/comment data that powers the CLI, so agents/tests can consume MCP servers with strong TypeScript types.

### Documentation & references
- Added `docs/tool-calling.md`, `docs/call-syntax.md`, and `docs/call-heuristic.md` to capture every invocation style (flags, function expressions, inferred verbs) plus the typo-correction rules.
- Expanded the ad-hoc/OAuth story across `README.md`, `docs/adhoc.md`, `docs/local.md`, `docs/known-issues.md`, and `docs/supabase-auth-issue.md`, detailing when servers auto-promote to OAuth, how retries behave, and how to persist generated definitions safely.
- Updated the README, CLI reference, and generator docs to cover the new `--all-parameters` flag, list formatter, metadata embedding, tmux debugging, the `mcporter emit-ts` workflow, and refreshed branding so the CLI and docs consistently introduce the project as **MCPorter**.
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
