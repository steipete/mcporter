# CLI Help Menu Snapshot
```
mcporter config
Usage: mcporter config [options] <command>

Manage configured MCP servers, imports, and ad-hoc discoveries.

Commands:
  list [options] [filter]        Show merged servers (local + imports + ad-hoc cache)
  get <name>                     Inspect a single server with resolved source info
  add [options] <name> [target]  Persist a server definition (URL or stdio command)
  remove [options] <name>        Delete a local entry or copy from an import
  import <kind> [options]        Copy entries from cursor/claude/codex/etc. into config
  login <name|url>               Complete OAuth/auth flows for a server
  logout <name>                  Clear cached credentials for a server
  doctor [options]               Validate config files and report common mistakes
  help [command]                 Show CLI or subcommand help

Global Options:
  --config <path>                Use an explicit config file (default: config/mcporter.json)
  --root <dir>                   Set project root for import discovery (default: cwd)
  --json                         Emit machine-readable output when supported
  -h, --help                     Display help for mcporter config

Run `mcporter config help add` to see transport flags, ad-hoc persistence tips, and schema docs.
See https://github.com/sweetistics/mcporter/blob/main/docs/config.md for config anatomy, import precedence, and troubleshooting guidance.
```

# Configuration Guide

## Overview
mcporter keeps three configuration buckets in sync: repository-scoped JSON (`config/mcporter.json`), imported editor configs (Cursor, Claude, Codex, Windsurf, VS Code), and ad-hoc definitions supplied on the CLI. This guide explains how those sources merge, how to mutate them with `mcporter config ...`, and the safety rails around OAuth, env interpolation, and persistence.

## Quick Start
1. Create `config/mcporter.json` at the repo root:
   ```jsonc
   {
     "mcpServers": {
       "linear": {
         "description": "Linear issues",
         "baseUrl": "https://mcp.linear.app/mcp",
         "headers": { "Authorization": "Bearer ${LINEAR_API_KEY}" }
       }
     },
     "imports": ["cursor", "claude-code", "codex"]
   }
   ```
2. Run `mcporter list linear` (or `mcporter config list linear`) to make sure the runtime can reach it.
3. Use `mcporter config add shadcn https://www.shadcn.io/api/mcp` to persist another server without editing JSON.
4. Authenticate any OAuth-backed server with either `mcporter auth <name>` or `mcporter config login <name>`; tokens land under `~/.mcporter/<name>/` unless you override `tokenCacheDir`.

## Discovery & Precedence
mcporter builds a merged view of all known servers before executing any command. The sources load in this order:

| Priority | Source | Notes |
| --- | --- | --- |
| 1 | Explicit `--http-url`, `--stdio`, or bare URL passed to commands | Highest priority, never cached unless `--persist` is supplied. Requires `--allow-http` for plain HTTP URLs. |
| 2 | `config/mcporter.json` (or the file passed via `--config`) | Default path is `<root>/config/mcporter.json`; missing file returns an empty config so commands continue to work. |
| 3 | Imports listed in `"imports"` | When you omit `imports`, mcporter loads `['cursor','claude-code','claude-desktop','codex','windsurf','vscode']`. When you specify a non-empty array, mcporter appends any omitted defaults after your list so shared presets remain available. |

Rules:
- Later sources never override earlier ones. Local config always wins over imports; ad-hoc descriptors override both for the duration of a command.
- Each merged server tracks its origin (local path vs. import path), so `mcporter config get <name>` can show you the path before you edit or remove the local copy with `mcporter config remove <name>`.
- Imports remain read-only until you explicitly copy an entry via `mcporter config import <kind> --copy` or run `mcporter config add --copy-from claude-code:linear` (feature planned alongside the CLI work).

## CLI Workflows
`mcporter config` is the entry point for reading and writing configuration files. Use the existing ad-hoc flags on `mcporter list|call|auth` when you want ephemeral definitions; once you’re ready to persist them, switch back to `mcporter config add`.

### `mcporter config list [filter]`
- Shows **local** entries by default. Pass `--source import` to list imported editor configs, or `--json` for machine output.
- Always appends a summary of other config files (paths, counts, sample names) so you know where imported entries live.
- `filter` accepts a name, glob fragment, or `source:cursor` selector.
- Adds informational notes when we auto-correct names (same machinery as `mcporter list`).

### `mcporter config get <name>`
- Prints the resolved definition for a single server, including the on-disk path, inherited headers/env, and transport details.
- Near-miss names are auto-corrected with the same heuristics as `mcporter list`/`call`, and you’ll see suggestions whenever ambiguity remains.
- Supports ad-hoc descriptors so you can inspect a URL before persisting it.

### `mcporter config add <name> [target]`
- Persists a server into the writable config file. Accepts both positional shortcuts (`mcporter config add sentry https://mcp.sentry.dev/mcp`) and flag-driven definitions:
  - `--transport http|sse|stdio`
  - `--url` or `--command`/`--stdio`
  - `--env`, `--header`, `--token-cache-dir`, `--description`, `--tag`, `--client-name`, `--oauth-redirect-url`
  - `--copy-from importKind:name` to clone settings from an imported entry before editing.
- `--dry-run` shows the JSON diff without writing, while `--persist <path>` overrides the destination file.

### `mcporter config remove <name>`
- Removes the local definition. Names sourced exclusively from imports remain untouched until you copy them locally.

### `mcporter config import <kind>`
- Displays (and optionally copies) entries from editor-specific configs:
  - `cursor`: `.cursor/mcp.json` in the repo, falling back to `~/.config/Cursor/User/mcp.json` (or `%APPDATA%/Cursor/User` on Windows).
  - `claude-code`: `<root>/.claude/mcp.json`, `~/.claude/mcp.json`, then `~/.claude.json`.
  - `claude-desktop`: platform-specific `Claude/claude_desktop_config.json` paths.
  - `codex`: `<root>/.codex/config.toml`, then `~/.codex/config.toml`.
  - `windsurf`: Codeium’s Windsurf config under `%APPDATA%/Codeium/windsurf/mcp_config.json` or `~/.codeium/windsurf/mcp_config.json`.
  - `vscode`: `Code/User/mcp.json` (stable + Insiders) inside the OS-appropriate config directory.
- `--copy` writes selected entries into your local config; `--filter <glob>` narrows the import list; `--path <file>` lets you point at bespoke locations.

### `mcporter config login <name|url>` / `logout`
- Mirrors `mcporter auth`. `login` completes OAuth (or token provisioning) for either a named server or an ad-hoc URL. When a hosted MCP returns 401/403, mcporter automatically promotes that target to OAuth and re-runs the flow, matching the behavior documented in `docs/adhoc.md`.
- `--browser none` suppresses automatic browser launch (useful for copying the URL into a remote browser).
- `logout` wipes token caches under `~/.mcporter/<name>/` (or the custom `tokenCacheDir`). Pass `--all` to clear everything.

### `mcporter config doctor`
- Early validator that checks for simple issues (e.g., OAuth entries missing cache paths). Future iterations will add fixes for Accept headers, duplicate imports, and more.

## Ad-hoc & Persistence
- `--http-url` and `--stdio` flags live on `mcporter list|call|auth`, keeping `mcporter config` focused on persistent config files.
- Names default to slugified hostnames or executable/script combos. Supply `--name` to improve reuse; mcporter uses that slug for OAuth caches even before persistence.
- `--allow-http` is mandatory for cleartext endpoints so we never downgrade transport silently.
- Add `--persist <path>` (defaulting to `config/mcporter.json` when omitted) to copy the ad-hoc definition into config. We reuse the same serializer as the import pipeline, so copying from Cursor → local config produces identical structure and preserves custom env/header fields.
- `--env KEY=VAL` entries merge with existing `env` dictionaries if you later persist the same server; nothing is lost when you alternate between CLI flags and JSON edits.

## Schema Reference
Top-level structure:

| Key | Type | Description |
| --- | --- | --- |
| `mcpServers` | object | Map of server names → definitions. Required even if empty. |
| `imports` | string[] | Optional list of import kinds. Empty array disables imports entirely; omitting the key falls back to the default list. |

Server definition fields (subset of what `RawEntrySchema` accepts):

| Field | Description |
| --- | --- |
| `description` | Free-form summary printed by `mcporter list`/`config list`. |
| `baseUrl` / `url` / `serverUrl` | HTTPS or HTTP endpoint. `http://` requires `--allow-http` in ad-hoc mode but works in config if you explicitly set it. |
| `command` / `args` | Stdio executable definition (string or array). Arrays are preferred because they avoid shell quoting issues. |
| `env` | Key/value pairs applied when launching stdio commands. Supports `${VAR}` interpolation and `${VAR:-fallback}` defaults. Existing process env values win over fallbacks. |
| `headers` | Request headers for HTTP/SSE transports. Values can reference `$env:VAR` or `${VAR}` placeholders, which must be set at runtime or mcporter aborts with a helpful error.
| `auth` | Currently only `oauth` is recognized. Any other string is ignored (treated as undefined) to avoid stale state from other clients. |
| `tokenCacheDir` | Directory for OAuth tokens; defaults to `~/.mcporter/<name>` when `auth === "oauth"`. Supports `~` expansion. |
| `clientName` | Optional identifier some servers use for telemetry/audience segmentation. |
| `oauthRedirectUrl` | Override the default localhost callback. Useful when tunneling OAuth through Codespaces or remote dev boxes. |

mcporter normalizes headers to include `Accept: application/json, text/event-stream` automatically, matching the runtime’s streaming expectations.

## Imports & Conflict Resolution
- `pathsForImport(kind, rootDir)` determines every candidate path. mcporter searches the repo first, then user-level directories, and stops at the first file that parses.
- Entries pulled from imports are treated as read-only snapshots. The merge process keeps the first definition for each name; later sources with the same name are skipped until you override locally.
- To copy an imported entry, either run `mcporter config import <kind> --copy --filter name` or use `mcporter config add name --copy-from kind:name`. The copy operation writes through the same JSON normalization stack, so the resulting file matches our schema even if the source format was TOML (Codex) or legacy JSON shapes (`servers` vs `mcpServers`).

## Project vs. Machine Layers
- Keep `config/mcporter.json` under version control. Encourage contributors to add sensitive data via env vars (`${LINEAR_API_KEY}`) rather than inline secrets.
- Machine-specific additions can live in `~/.mcporter/local.json`; point `mcporter config --config ~/.mcporter/local.json add ...` there when you prefer not to touch the repo. Since the runtime only watches one config at a time, CI jobs should always pass `--config config/mcporter.json` (or run from the repo root) for deterministic behavior.
- OAuth tokens, cached server metadata, and generated CLIs should remain outside the repo (`~/.mcporter/<name>/`, `dist/`).

## Validation & Troubleshooting
- `mcporter list --http-url ...` refuses to auto-run OAuth to keep listing commands quick; use `mcporter config login ...` or `mcporter auth ...` to finish credential setup.
- When env placeholders are missing, commands fail fast with the exact variable name. Add the variable or wrap it in `${VAR:-fallback}` to provide defaults.
- Use `mcporter config get <name> --show-source` (planned flag) to confirm whether a server came from an import. If a teammate’s Cursor config keeps overriding your local entry, reorder the `imports` array to move Cursor later or set it to `[]` to disable imports entirely.
- `docs/adhoc.md` covers deeper debugging, including tmux workflows and OAuth promotion logs.

## Outstanding Coverage Items
- Describe how `--persist` writes through the same import merge pipeline (especially once `mcporter config add --copy-from` ships) so users know exactly which file changes.
- Call out that `--allow-http` remains required for cleartext URLs even in config mutations, and reiterate that `--env KEY=VAL` merges with on-disk env blocks rather than replacing them entirely.
- Clarify and illustrate the automatic OAuth promotion path for ad-hoc HTTP entries in both this doc and future `mcporter config login` help output.
- Flesh out `mcporter config doctor` once the validator is implemented so we can show real output samples and suggested fixes.
