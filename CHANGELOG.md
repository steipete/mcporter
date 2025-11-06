# Changelog

## [Unreleased]

- _No changes yet._

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
- Generated artifacts now emit `<artifact>.metadata.json` files plus `mcporter inspect-cli` / `mcporter regenerate-cli` workflows (with `--dry-run` and overrides) so binaries can be refreshed after upgrading mcporter.
- Fixed `mcporter call <server> <tool>` so the second positional is treated as the tool name instead of triggering the "Argument must be key=value" error, accepted `tool=`/`command=` selectors now play nicely with additional key=value payloads, and added a default call timeout (configurable via `MCPORTER_CALL_TIMEOUT` or `--timeout`) that tears down the MCP transport—clearing internal timers and ignoring blank env overrides—so long-running or completed tools can’t leave the CLI hanging open.

## [0.1.0]

- Initial release.
