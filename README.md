# MCPorter 🧳
_TypeScript runtime, CLI, and code-generation toolkit for the Model Context Protocol._

MCPorter helps you lean into the "code execution" workflows highlighted in Anthropic's **Code Execution with MCP** guidance: discover the MCP servers already configured on your system, call them directly, compose richer automations in TypeScript, and mint single-purpose CLIs when you need to share a tool. All of that works out of the box -- no boilerplate, no schema spelunking.

## Key Capabilities

- **Zero-config discovery.** `createRuntime()` merges your home config (`~/.mcporter/mcporter.json[c]`) first, then `config/mcporter.json`, plus Cursor/Claude/Codex/Windsurf/OpenCode/VS Code imports, expands `${ENV}` placeholders, and pools connections so you can reuse transports across multiple calls.
- **One-command CLI generation.** `mcporter generate-cli` turns any MCP server definition into a ready-to-run CLI, with optional bundling/compilation and metadata for easy regeneration.
- **Typed tool clients.** `mcporter emit-ts` emits `.d.ts` interfaces or ready-to-run client wrappers so agents/tests can call MCP servers with strong TypeScript types without hand-writing plumbing.
- **Friendly composable API.** `createServerProxy()` exposes tools as ergonomic camelCase methods, automatically applies JSON-schema defaults, validates required arguments, and hands back a `CallResult` with `.text()`, `.markdown()`, `.json()`, and `.content()` helpers.
- **OAuth and stdio ergonomics.** Built-in OAuth caching, log tailing, and stdio wrappers let you work with HTTP, SSE, and stdio transports from the same interface.
- **Ad-hoc connections.** Point the CLI at *any* MCP endpoint (HTTP or stdio) without touching config, then persist it later if you want. Hosted MCPs that expect a browser login (Supabase, Vercel, etc.) are auto-detected—just run `mcporter auth <url>` and the CLI promotes the definition to OAuth on the fly. See [docs/adhoc.md](docs/adhoc.md).

## Quick Start

MCPorter auto-discovers the MCP servers you already configured in Cursor, Claude Code/Desktop, Codex, or local overrides. You can try it immediately with `npx`--no installation required. Need a full command reference (flags, modes, return types)? Check out [docs/cli-reference.md](docs/cli-reference.md).
### Call syntax options

```bash
# Colon-delimited flags (shell-friendly)
npx mcporter call linear.create_comment issueId:ENG-123 body:'Looks good!'

# Function-call style (matches signatures from `mcporter list`)
npx mcporter call 'linear.create_comment(issueId: "ENG-123", body: "Looks good!")'
```


### List your MCP servers

```bash
npx mcporter list
npx mcporter list context7 --schema
npx mcporter list https://mcp.linear.app/mcp --all-parameters
npx mcporter list shadcn.io/api/mcp.getComponents           # URL + tool suffix auto-resolves
npx mcporter list --stdio "bun run ./local-server.ts" --env TOKEN=xyz
```

- Add `--json` to emit a machine-readable summary with per-server statuses (auth/offline/http/error counts) and, for single-server runs, the full tool schema payload.
- Add `--verbose` to show every config source that registered the server name (primary first), both in text and JSON list output.

You can now point `mcporter list` at ad-hoc servers: provide a URL directly or use the new `--http-url/--stdio` flags (plus `--env`, `--cwd`, `--name`, or `--persist`) to describe any MCP endpoint. Until you persist that definition, you still need to repeat the same URL/stdio flags for `mcporter call`—the printed slug only becomes reusable once you merge it into a config via `--persist` or `mcporter config add` (use `--scope home|project` to pick the write target). Follow up with `mcporter auth https://…` (or the same flag set) to finish OAuth without editing config. Full details live in [docs/adhoc.md](docs/adhoc.md).

Single-server listings now read like a TypeScript header file so you can copy/paste the signature straight into `mcporter call`:

```ts
linear - Hosted Linear MCP; exposes issue search, create, and workflow tooling.
  23 tools · 1654ms · HTTP https://mcp.linear.app/mcp

  /**
   * Create a comment on a specific Linear issue
   * @param issueId The issue ID
   * @param body The content of the comment as Markdown
   * @param parentId? A parent comment ID to reply to
   */
  function create_comment(issueId: string, body: string, parentId?: string);
  // optional (3): notifySubscribers, labelIds, mentionIds

  /**
   * List documents in the user's Linear workspace
   * @param query? An optional search query
   * @param projectId? Filter by project ID
   */
  function list_documents(query?: string, projectId?: string);
  // optional (11): limit, before, after, orderBy, initiativeId, ...
```

Here’s what that looks like for Vercel when you run `npx mcporter list vercel`:

```ts
vercel - Vercel MCP (requires OAuth).

  /**
   * Search the Vercel documentation.
   * Use this tool to answer any questions about Vercel’s platform, features, and best practices,
   * including:
   * - Core Concepts: Projects, Deployments, Git Integration, Preview Deployments, Environments
   * - Frontend & Frameworks: Next.js, SvelteKit, Nuxt, Astro, Remix, frameworks configuration and
   *   optimization
   * - APIs: REST API, Vercel SDK, Build Output API
   * - Compute: Fluid Compute, Functions, Routing Middleware, Cron Jobs, OG Image Generation, Sandbox,
   *   Data Cache
   * - AI: Vercel AI SDK, AI Gateway, MCP, v0
   * - Performance & Delivery: Edge Network, Caching, CDN, Image Optimization, Headers, Redirects,
   *   Rewrites
   * - Pricing: Plans, Spend Management, Billing
   * - Security: Audit Logs, Firewall, Bot Management, BotID, OIDC, RBAC, Secure Compute, 2FA
   * - Storage: Blog, Edge Config
   *
   * @param topic Topic to focus the documentation search on (e.g., 'routing', 'data-fetching').
   * @param tokens? Maximum number of tokens to include in the result. Default is 2500.
   */
  function search_vercel_documentation(topic: string, tokens?: number);

  /**
   * Deploy the current project to Vercel
   */
  function deploy_to_vercel();
```

Required parameters always show; optional parameters stay hidden unless (a) there are only one or two of them alongside fewer than four required fields or (b) you pass `--all-parameters`. Whenever MCPorter hides parameters it prints `Optional parameters hidden; run with --all-parameters to view all fields.` so you know how to reveal the full signature. Return types are inferred from the tool schema’s `title`, falling back to omitting the suffix entirely instead of guessing.

### Context7: fetch docs (no auth required)

```bash
npx mcporter call context7.resolve-library-id libraryName=react
npx mcporter call context7.get-library-docs context7CompatibleLibraryID=/websites/react_dev topic=hooks
```

### Linear: search documentation (requires `LINEAR_API_KEY`)

```bash
LINEAR_API_KEY=sk_linear_example npx mcporter call linear.search_documentation query="automations"
```

### Chrome DevTools: snapshot the current tab

```bash
npx mcporter call chrome-devtools.take_snapshot
npx mcporter call 'linear.create_comment(issueId: "LNR-123", body: "Hello world")'
npx mcporter call https://mcp.linear.app/mcp.list_issues assignee=me
npx mcporter call shadcn.io/api/mcp.getComponent component=vortex   # protocol optional; defaults to https
npx mcporter call linear.listIssues --tool listIssues   # auto-corrects to list_issues
npx mcporter linear.list_issues                         # shorthand: infers `call`
VERCEL_ACCESS_TOKEN=sk_vercel_example npx mcporter call "npx -y vercel-domains-mcp" domain=answeroverflow.com  # quoted stdio cmd + single-tool inference
```

> Tool calls understand a JavaScript-like call syntax, auto-correct near-miss tool names, and emit richer inline usage hints. See [docs/call-syntax.md](docs/call-syntax.md) for the grammar and [docs/call-heuristic.md](docs/call-heuristic.md) for the auto-correction rules.

Helpful flags:

- `--config <path>` -- custom config file (defaults to `./config/mcporter.json`).
- `--root <path>` -- working directory for stdio commands.
- `--log-level <debug|info|warn|error>` -- adjust verbosity (respects `MCPORTER_LOG_LEVEL`).
- `--oauth-timeout <ms>` -- shorten/extend the OAuth browser wait; same as `MCPORTER_OAUTH_TIMEOUT_MS` / `MCPORTER_OAUTH_TIMEOUT`.
- `--tail-log` -- stream the last 20 lines of any log files referenced by the tool response.
- `--output <format>` or `--raw` -- control formatted output (defaults to pretty-printed auto detection).
- `--json` (on `mcporter list`) -- emit JSON summaries/counts instead of text. Multi-server runs report per-server statuses, counts, and connection issues; single-server runs include the full tool metadata.
- `--output json/raw` (on `mcporter call`) -- when a connection fails, MCPorter prints the usual colorized hint and also emits a structured `{ server, tool, issue }` envelope so scripts can handle auth/offline/http errors programmatically.
- `--json` (on `mcporter auth`) -- emit the same structured connection envelope whenever OAuth/transport setup fails, instead of throwing an error.
- `--json` (on `mcporter emit-ts`) -- print a JSON summary describing the emitted files (mode + output paths) instead of text logs—handy when generating artifacts inside scripts.
- `--all-parameters` -- show every schema field when listing a server (default output shows at least five parameters plus a summary of the rest).
- `--http-url <https://…>` / `--stdio "command …"` -- describe an ad-hoc MCP server inline. STDIO transports now inherit your current shell environment automatically; add `--env KEY=value` only when you need to inject/override variables alongside `--cwd`, `--name`, or `--persist <config.json>`. These flags now work with `mcporter auth` too, so `mcporter auth https://mcp.example.com/mcp` just works.
- For OAuth-protected servers such as `vercel`, run `npx mcporter auth vercel` once to complete login.

> Tip: You can skip the verb entirely—`mcporter firecrawl` automatically runs `mcporter list firecrawl`, and dotted tokens like `mcporter linear.list_issues` dispatch to the call command (typo fixes included).

Timeouts default to 30 s; override with `MCPORTER_LIST_TIMEOUT` or `MCPORTER_CALL_TIMEOUT` when you expect slow startups. OAuth browser handshakes get a separate 60 s grace period; pass `--oauth-timeout <ms>` (or export `MCPORTER_OAUTH_TIMEOUT_MS`) when you need the CLI to bail out faster while you diagnose stubborn auth flows.

### Try an MCP without editing config

```bash
# Point at an HTTPS MCP server directly
npx mcporter list --http-url https://mcp.linear.app/mcp --name linear

# Run a local stdio MCP server via Bun
npx mcporter call --stdio "bun run ./local-server.ts" --name local-tools
```

- Add `--persist config/mcporter.local.json` to save the inferred definition for future runs.
- Use `--allow-http` if you truly need to hit a cleartext endpoint.
- See [docs/adhoc.md](docs/adhoc.md) for a deep dive (env overrides, cwd, OAuth).

### Keep MCP servers warm with the daemon

- `chrome-devtools`, `mobile-mcp`, and other stateful stdio servers auto-start a per-login daemon the first time you call them so Chrome tabs and device sessions stay alive between agents.
- Use `mcporter daemon status` to check whether the daemon is running (and which servers are connected).
- Stop it anytime with `mcporter daemon stop`, pre-warm with `mcporter daemon start`, or bounce it via `mcporter daemon restart` after tweaking configs/env.
- All other servers stay ephemeral; add `"lifecycle": "keep-alive"` to a server entry (or set `MCPORTER_KEEPALIVE=name`) when you want the daemon to manage it. You can also set `"lifecycle": "ephemeral"` (or `MCPORTER_DISABLE_KEEPALIVE=name`) to opt out.
- The daemon only manages named servers that come from your config/imports. Ad-hoc STDIO/HTTP targets invoked via `--stdio …`, `--http-url …`, or inline function-call syntax remain per-process today; persist them into `config/mcporter.json` (or use `--persist`) if you need them to participate in the shared daemon.
- Troubleshooting? Run `mcporter daemon start --log` (or `--log-file /tmp/daemon.log`) to tee stdout/stderr into a file, and add `--log-servers chrome-devtools` when you only want call traces for a specific MCP. Per-server configs can also set `"logging": { "daemon": { "enabled": true } }` to force detailed logging for that entry.


## Friendlier Tool Calls

- **Function-call syntax.** Instead of juggling `--flag value`, you can call tools as `mcporter call 'linear.create_issue(title: "Bug", team: "ENG")'`. The parser supports nested objects/arrays, lets you omit labels when you want to rely on schema order (e.g. `mcporter 'context7.resolve-library-id("react")'`), and surfaces schema validation errors clearly. Deep dive in [docs/call-syntax.md](docs/call-syntax.md).
- **Flag shorthand still works.** Prefer CLI-style arguments? Stick with `mcporter linear.create_issue title=value team=value`, `title=value`, `title:value`, or even `title: value`—the CLI now normalizes all three forms.
- **Cheatsheet.** See [docs/tool-calling.md](docs/tool-calling.md) for a quick comparison of every supported call style (auto-inferred verbs, flags, function-calls, and ad-hoc URLs).
- **Auto-correct.** If you typo a tool name, MCPorter inspects the server’s tool catalog, retries when the edit distance is tiny, and otherwise prints a `Did you mean …?` hint. The heuristic (and how to tune it) is captured in [docs/call-heuristic.md](docs/call-heuristic.md).
- **Richer single-server output.** `mcporter list <server>` now prints TypeScript-style signatures, inline comments, return-shape hints, and command examples that mirror the new call syntax. Optional parameters stay hidden by default—add `--all-parameters` or `--schema` whenever you need the full JSON schema.


## Installation

### Run instantly with `npx`

```bash
npx mcporter list
```

### Add to your project

```bash
pnpm add mcporter
```

### Homebrew (steipete/tap)

```bash
brew tap steipete/tap
brew install steipete/tap/mcporter
```

> The tap publishes alongside MCPorter 0.3.2. If you run into issues with an older tap install, run `brew update` before reinstalling.

## One-shot calls from code

```ts
import { callOnce } from "mcporter";

const result = await callOnce({
	server: "firecrawl",
	toolName: "crawl",
	args: { url: "https://anthropic.com" },
});

console.log(result); // raw MCP envelope
```

`callOnce` automatically discovers the selected server (including Cursor/Claude/Codex/Windsurf/OpenCode/VS Code imports), handles OAuth prompts, and closes transports when it finishes. It is ideal for manual runs or wiring MCPorter directly into an agent tool hook.

## Compose Automations with the Runtime

```ts
import { createRuntime } from "mcporter";

const runtime = await createRuntime();

const tools = await runtime.listTools("context7");
const result = await runtime.callTool("context7", "resolve-library-id", {
	args: { libraryName: "react" },
});

console.log(result); // prints JSON/text automatically because the CLI pretty-prints by default
await runtime.close(); // shuts down transports and OAuth sessions
```

Reach for `createRuntime()` when you need connection pooling, repeated calls, or advanced options such as explicit timeouts and log streaming. The runtime reuses transports, refreshes OAuth tokens, and only tears everything down when you call `runtime.close()`.

## Compose Tools in Code

The runtime API is built for agents and scripts, not just humans at a terminal.

```ts
import { createRuntime, createServerProxy } from "mcporter";

const runtime = await createRuntime();
const chrome = createServerProxy(runtime, "chrome-devtools");
const linear = createServerProxy(runtime, "linear");

const snapshot = await chrome.takeSnapshot();
console.log(snapshot.text());

const docs = await linear.searchDocumentation({
	query: "automations",
	page: 0,
});
console.log(docs.json());
```

Friendly ergonomics baked into the proxy and result helpers:

- Property names map from camelCase to kebab-case tool names (`takeSnapshot` -> `take_snapshot`).
- Positional arguments map onto schema-required fields automatically, and option objects respect JSON-schema defaults.
- Results are wrapped in a `CallResult`, so you can choose `.text()`, `.markdown()`, `.json()`, `.content()`, or access `.raw` when you need the full envelope.

Drop down to `runtime.callTool()` whenever you need explicit control over arguments, metadata, or streaming options.


Call `mcporter list <server>` any time you need the TypeScript-style signature, optional parameter hints, and sample invocations that match the CLI's function-call syntax.

### Config-based result mapping

Some tools return very large JSON objects when you only care about a few fields. You can declare per-tool projections in `config/mcporter.json` so that `CallResult.json()` only returns the fields you care about while `.raw` still exposes the full MCP envelope.

```jsonc
{
  "mcpServers": {
    "linear": {
      "baseUrl": "https://mcp.linear.app/mcp",
      "resultMapping": {
        "list_documents": {
          // Only keep these fields from the JSON result
          "pick": ["id", "title", "url"]
        }
      }
    }
  }
}
```

Rules:

* `resultMapping` is defined per server.
* Keys under `resultMapping` are the canonical MCP tool names (`list_documents`, `search_documentation`, etc.) as printed by `mcporter list <server>`.
* `pick` is an array of JSON paths relative to the root value returned by `.json()`. Paths use simple dot-notation for nesting (`"customer.name"`, `"metadata.stats.views"`).
* Nested paths preserve their structure in the output—`["id", "metadata.author"]` produces `{ id: "...", metadata: { author: "..." } }`.
* When the root result is an array, the projection is applied to each element.
* The mapping only affects `.json()` and helpers that depend on it (including `mcporter call --output json`). `CallResult.raw` and `--output raw` still show the full unmodified MCP response.

## Generate a Standalone CLI

Turn any server definition into a shareable CLI artifact:

```bash
npx mcporter generate-cli \
  --command https://mcp.context7.com/mcp

# Outputs:
#   context7.ts        (TypeScript template with embedded schemas)
#   context7.js        (bundled CLI via Rolldown or Bun, depending on runtime)
```

> Convert the chrome-devtools MCP to a CLI via this one weird trick:
>
> `npx mcporter generate-cli --command "npx -y chrome-devtools-mcp@latest"`

Tip: you can drop `--command` when the inline command is the first positional argument (e.g., `npx mcporter generate-cli "npx -y chrome-devtools-mcp@latest"`).

- `--name` overrides the inferred CLI name.
- Add `--description "..."` if you want a custom summary in the generated help output (otherwise mcporter asks the MCP server for its own description/title during generation).
- Generated CLIs inherit the same color-aware help layout as `mcporter` itself: invoking the binary with no arguments shows the embedded tool list + quick start, and each `--help` page uses bold titles + dimmed descriptions when stdout is a TTY.
- Add `--bundle [path]` to emit a bundle alongside the template (Rolldown when targeting Node, Bun automatically when the runtime resolves to Bun; override with `--bundler rolldown|bun`).
- `--output <path>` writes the template somewhere specific.
- `--runtime bun|node` picks the runtime for generated code (Bun required for `--compile`).
- Add `--compile` to emit a Bun-compiled binary; MCPorter cleans up intermediate bundles when you omit `--bundle`.
- Use `--from <artifact>` (optionally `--dry-run`) to regenerate an existing CLI using its embedded metadata.
- Prefer a positional shorthand if the server already lives in your config/imports:
  `npx mcporter generate-cli linear --bundle dist/linear.js`.
- `--server`/`--command` accept HTTP URLs, optional `.tool` suffixes, and even scheme-less hosts (`shadcn.io/api/mcp.getComponents`).

Every artifact embeds regeneration metadata (generator version, resolved server definition, invocation flags). Use:

```
npx mcporter inspect-cli dist/context7.js     # human-readable summary
npx mcporter generate-cli --from dist/context7.js  # replay with latest mcporter
```

## Generate Typed Clients

Use `mcporter emit-ts` when you want strongly typed tooling without shipping a full CLI. It reuses the same signatures/doc blocks as `mcporter list`, so the generated headers stay in sync with what the CLI shows.

```bash
# Types-only interface (Promise signatures)
npx mcporter emit-ts linear --out types/linear-tools.d.ts

# Client wrapper (creates a reusable proxy factory alongside the .d.ts)
npx mcporter emit-ts linear --mode client --out clients/linear.ts
```

- `--mode types` (default) produces a `.d.ts` interface you can import anywhere.
- `--mode client` emits the `.d.ts` **and** a `.ts` helper that wraps `createRuntime` / `createServerProxy` for you.
- Add `--include-optional` whenever you want every optional field spelled out (mirrors `mcporter list --all-parameters`).
- Add `--json` to emit a structured summary (mode plus output paths) instead of plain-text logs when scripting `emit-ts`.
- The `<server>` argument also understands HTTP URLs and selectors with `.tool` suffixes or missing protocols—mirroring the main CLI.

See [docs/emit-ts.md](docs/emit-ts.md) for the full flag reference plus inline snapshots of the emitted files.

## Configuration Reference

Manage this file with `mcporter config list|get|add|remove|import` when you’d rather avoid hand-editing JSON; see [docs/config.md](docs/config.md) for the full walkthrough.

### Manage configs with `mcporter config`

Run `mcporter config …` via your package manager (pnpm, npm, npx, etc.) when you want an interactive view of project MCPs:

- `config list` shows **only local entries** by default and, on TTYs, prints a summary of every other config file (Cursor, Claude, Windsurf, VS Code, etc.) with counts and sample names. Add `--source import` to inspect those imported entries directly or `--json` for scripting.
- `config get/remove/logout` reuse the fuzzy matching logic from `mcporter list`/`call`, so typos like `sshadcn` auto-correct to `shadcn` (with a dimmed notice) and ambiguous names surface “Did you mean …?” hints.
- `config import <kind> --copy` pulls editor-managed entries into `config/mcporter.json`, letting you customize or remove them locally without touching upstream files.
- Every subcommand honors `--config <path>` / `--root <dir>`, making it easy to juggle multiple project configs or workspace-specific overrides.

`config/mcporter.json` mirrors Cursor/Claude's shape:

```jsonc
{
	"mcpServers": {
		"context7": {
			"description": "Context7 docs MCP",
			"baseUrl": "https://mcp.context7.com/mcp",
			"headers": {
				"Authorization": "$env:CONTEXT7_API_KEY"
			}
		},
		"chrome-devtools": {
			"command": "npx",
			"args": ["-y", "chrome-devtools-mcp@latest"],
			"env": { "npm_config_loglevel": "error" }
		},
		"linear": {
			"baseUrl": "https://mcp.linear.app/mcp",

			"resultMapping": {
				// Only keep selected fields when calling list_documents
				"list_documents": {
					"pick": ["id", "title", "url"]
				}
			}
		}
	},
	"imports": ["cursor", "claude-code", "claude-desktop", "codex", "windsurf", "opencode", "vscode"]
}
```

What MCPorter handles for you:

- `${VAR}`, `${VAR:-fallback}`, and `$env:VAR` interpolation for headers and env entries.
- Automatic OAuth token caching under `~/.mcporter/<server>/` unless you override `tokenCacheDir`.
- Stdio commands inherit the directory of the file that defined them (imports or local config).
- Import precedence matches the array order; omit `imports` to use the default `["cursor", "claude-code", "claude-desktop", "codex", "windsurf", "opencode", "vscode"]`.
- You can override imported servers by adding a local entry with the same name and a `resultMapping` block; MCPorter's merge logic keeps the imported transport definition but lets you configure mappings and other overrides locally.

Provide `configPath` or `rootDir` to CLI/runtime calls when you juggle multiple config files side by side.

#### Config resolution order & system-level configs

mcporter reads exactly one primary config per run. The lookup order is:

1. The path you pass via `--config` (or programmatic `configPath`).
2. The `MCPORTER_CONFIG` environment variable (set it in your shell to apply everywhere).
3. `<root>/config/mcporter.json` inside the current project.
4. `~/.mcporter/mcporter.json` or `~/.mcporter/mcporter.jsonc` if the project file is missing.

All `mcporter config …` mutations write back to whichever file was selected by that order. To manage a system-wide config explicitly, point the CLI at it:

```bash
mcporter config --config ~/.mcporter/mcporter.json add global-server https://api.example.com/mcp
```

Set `MCPORTER_CONFIG=~/.mcporter/mcporter.json` in your shell profile when you want that file to be the default everywhere (handy for `npx mcporter …` runs).

## Testing and CI

| Command | Purpose |
| --- | --- |
| `pnpm check` | Biome formatting plus Oxlint/tsgolint gate. |
| `pnpm build` | TypeScript compilation (emits `dist/`). |
| `pnpm test` | Vitest unit and integration suites (streamable HTTP fixtures included). |

CI runs the same trio via GitHub Actions.

## Debug Hanging Servers Quickly

Use `tmux` to keep long-running CLI sessions visible while you investigate lingering MCP transports:

```bash
tmux new-session -- pnpm mcporter:list
```

Let it run in the background, then inspect the pane (`tmux capture-pane -pt <session>`), tail stdio logs, or kill the session once the command exits. Pair this with `MCPORTER_DEBUG_HANG=1` when you need verbose handle diagnostics. More detail: [docs/tmux.md](docs/tmux.md) and [docs/hang-debug.md](docs/hang-debug.md).

## License

MIT -- see [LICENSE](LICENSE).

Further reading: [docs/tool-calling.md](docs/tool-calling.md), [docs/call-syntax.md](docs/call-syntax.md), [docs/adhoc.md](docs/adhoc.md), [docs/emit-ts.md](docs/emit-ts.md), [docs/tmux.md](docs/tmux.md).
