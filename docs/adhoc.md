# Ad-hoc MCP Servers

mcporter is gaining support for "just try it" workflows where you point the CLI at a raw MCP endpoint without first editing a config file. This doc tracks the behavior and heuristics we use to make that experience smooth while keeping the runtime predictable.

## Entry Points

Two new flag sets let you describe a server on the command line:

- `mcporter list --http-url https://mcp.linear.app/mcp [--name linear]`
- `mcporter call --stdio "bun run ./server.ts" --name local-tools`

You can also pass a bare URL as the selector (`mcporter list https://mcp.linear.app/mcp`) or embed the URL in a `call` expression (`mcporter call 'https://mcp.example.com/tools.generate({ topic: "release" })'`).
- Add `--json` to `mcporter list …` when you need a machine-readable summary of status counts and per-server failures, use `--output json`/`--output raw` with `mcporter call` to receive structured `{ server, tool, issue }` envelopes whenever a transport error occurs, and run `mcporter auth … --json` to capture the same envelope if OAuth or transport setup fails.

## Transport Detection

- **HTTP(S)**: Providing a URL defaults to the streamable HTTP transport. `https://` works out of the box; `http://` requires `--allow-http` to acknowledge cleartext traffic.
- **STDIO**: Supplying `--stdio` (with a command string) or `--stdio-bin` (binary + args) selects the stdio transport. We accept optional `--cwd` and `--env KEY=value` pairs.
- **Conflict guard**: Passing both URL and stdio flags errors out so we don’t guess.

## Naming & Identity

- `--name` wins when provided.
- Otherwise we derive a slug:
  - HTTP: `<host>` plus a sanitized path fragment (e.g. `mcp-linear-app-mcp`).
  - STDIO: executable basename + script (`node-singlestep`).
- The inferred name is printed so you know what to reuse later. If you don’t persist the definition, run `mcporter auth https://mcp.linear.app/mcp` (or supply `--name linear` so `mcporter auth linear` also works) to finish OAuth with the same settings.

This name becomes the cache key for OAuth tokens and log preferences, so repeated ad-hoc calls still benefit from credential reuse.

## OAuth Auto-Detection

Many hosted MCP servers (Supabase, Vercel, etc.) advertise OAuth capabilities but expect clients to discover this dynamically. When an ad-hoc HTTP server responds with `401/403` during the initial handshake, mcporter now:

1. **Promotes the definition to OAuth** and spins up the default browser flow—no need to edit config or supply `auth: "oauth"` manually.
2. **Persists the change** whenever you pass `--persist`, so future runs remember that the endpoint requires OAuth without repeating the detection step.

The CLI still avoids surprise prompts during `mcporter list`; the upgrade happens the first time you run `mcporter auth <url>` or any other command that allows OAuth (i.e., not in `--autoAuthorize=false` mode).

## Auth & Persistence

- OAuth flows are allowed; successful tokens store under the inferred name just like regular definitions.
- `mcporter auth` accepts the same `--http-url/--stdio` flags (and even bare URLs), so you can immediately re-run `mcporter auth https://…` after a 401 without touching a config file.
- Nothing is written to disk unless you pass `--persist /path/to/config.json`. When set, we merge the generated definition into that file (creating it if necessary) so future runs can rely on the standard config pipeline.

## Safety Nets

- Non-HTTPS endpoints require `--allow-http`.
- For stdio commands we print a confirmation snippet the first time we see a new command unless `--yes` is present.
- Missing transports or malformed combinations throw descriptive errors, pointing to `docs/adhoc.md` for guidance.

## Follow-ups

- Extend `mcporter config add` to leverage the same helper, making it the one-stop path from exploration to permanence.
- Consider caching inference results so repeated URL calls automatically rehydrate the previous settings (env/cwd).
