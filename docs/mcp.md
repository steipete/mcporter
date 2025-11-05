---
summary: 'Working with configured MCP servers via the mcp-runtime CLI and scripts.'
---

# MCP Workflow

`mcp-runtime` reads server definitions from `config/mcp_servers.json`. Each entry mirrors the Sweetistics setup (headers, stdio wrappers, OAuth hints) so team members can lean on the same command surface area without Python dependencies.

## Scripts

```
pnpm mcp:list [<name>] [--schema]
pnpm mcp:call <server>.<tool> [key=value...] [--args '{"foo":"bar"}'] [--tail-log]
```

Both scripts forward straight to the TypeScript CLI (`src/cli.ts`), so they support the same flags documented in the [README](../README.md).

- `pnpm mcp:list` – enumerate all configured servers; pass a specific name to inspect tool signatures.
- `pnpm mcp:list <name> --schema` – dump the full JSON schema for each tool exposed by `<name>`.
- `pnpm mcp:call` – execute a tool using either loose `key=value` pairs or `--args` JSON; append `--tail-log` to follow log files reported by the response.

## Adding or Updating Servers

1. Edit `config/mcp_servers.json` (keep the entries sorted alphabetically).
2. Use `${ENV}` or `${ENV:-default}` placeholders for secrets; they are resolved at runtime.
3. Set `auth: "oauth"` when the server requires an OAuth dance – the CLI spins up a local callback server and persists tokens under `~/.mcp-runtime/<name>/`.
4. For stdio transports, wrap the command with `scripts/mcp_stdio_wrapper.sh` to inherit repo-relative paths, just like the Sweetistics helper.

After editing the config, you can validate the entry with:

```
pnpm mcp:list <name>
pnpm mcp:call <name>.<tool> --args '{"sample":true}'
```

## Environment Variables

The CLI respects the same conventions as the original Python wrapper:

- `${LINEAR_API_KEY}`, `${FIRECRAWL_API_KEY}`, etc. for hosted servers.
- `$env:VAR` to inject the raw runtime value without fallbacks.
- `env` blocks per entry to provide default values (e.g., SigNoz URLs/tokens).

## Troubleshooting

| Issue | Suggested Fix |
| --- | --- |
| OAuth flow never completes | Ensure the browser opened `http://127.0.0.1:<port>/callback`; copy the printed URL manually if not. |
| Stdio command cannot find scripts | Pass `--root <repo>` or run from the project root so relative paths resolve. |
| Tokens are stale | Delete `~/.mcp-runtime/<server>/tokens.json` and rerun the command. |

Refer to [`docs/spec.md`](./spec.md) for deeper architectural notes and future roadmap items.
