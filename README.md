# mcporter 🧳
_TypeScript runtime, CLI, and code-generation toolkit for the Model Context Protocol._

mcporter helps you lean into the "code execution" workflows highlighted in Anthropic's **Code Execution with MCP** guidance: discover the MCP servers already configured on your system, call them directly, compose richer automations in TypeScript, and mint single-purpose CLIs when you need to share a tool. All of that works out of the box -- no boilerplate, no schema spelunking.

## Key Capabilities

- **Zero-config discovery.** `createRuntime()` loads `config/mcporter.json`, merges Cursor/Claude/Codex/Windsurf/VS Code imports, expands `${ENV}` placeholders, and pools connections so you can reuse transports across multiple calls.
- **One-command CLI generation.** `mcporter generate-cli` turns any MCP server definition into a ready-to-run CLI, with optional bundling/compilation and metadata for easy regeneration.
- **Friendly composable API.** `createServerProxy()` exposes tools as ergonomic camelCase methods, automatically applies JSON-schema defaults, validates required arguments, and hands back a `CallResult` with `.text()`, `.markdown()`, `.json()`, and `.content()` helpers.
- **OAuth and stdio ergonomics.** Built-in OAuth caching, log tailing, and stdio wrappers let you work with HTTP, SSE, and stdio transports from the same interface.
- **Ad-hoc connections.** Point the CLI at *any* MCP endpoint (HTTP or stdio) without touching config, then persist it later if you want. Hosted MCPs that expect a browser login (Supabase, Vercel, etc.) are auto-detected—just run `mcporter auth <url>` and the CLI promotes the definition to OAuth on the fly. See [docs/adhoc.md](docs/adhoc.md).

## Quick Start

mcporter auto-discovers the MCP servers you already configured in Cursor, Claude Code/Desktop, Codex, or local overrides. You can try it immediately with `npx`--no installation required. Need a full command reference (flags, modes, return types)? Check out [docs/cli-reference.md](docs/cli-reference.md).
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
npx mcporter list --stdio "bun run ./local-server.ts" --env TOKEN=xyz
```

You can now point `mcporter list` at ad-hoc servers: provide a URL directly or use the new `--http-url/--stdio` flags (plus `--env`, `--cwd`, `--name`, or `--persist`) to describe any MCP endpoint. Follow up with `mcporter auth https://…` (or the same flag set) to finish OAuth without editing config. Full details live in [docs/adhoc.md](docs/adhoc.md).

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

Required parameters always show; optional parameters stay hidden unless (a) there are only one or two of them alongside fewer than four required fields or (b) you pass `--all-parameters`. Whenever mcporter hides parameters it prints `Optional parameters hidden; run with --all-parameters to view all fields.` so you know how to reveal the full signature. Return types are inferred from the tool schema’s `title`, falling back to omitting the suffix entirely instead of guessing.

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
npx mcporter call linear.listIssues --tool listIssues   # auto-corrects to list_issues
npx mcporter linear.list_issues                         # shorthand: infers `call`
```

> Tool calls understand a JavaScript-like call syntax, auto-correct near-miss tool names, and emit richer inline usage hints. See [docs/call-syntax.md](docs/call-syntax.md) for the grammar and [docs/call-heuristic.md](docs/call-heuristic.md) for the auto-correction rules.

Helpful flags:

- `--config <path>` -- custom config file (defaults to `./config/mcporter.json`).
- `--root <path>` -- working directory for stdio commands.
- `--log-level <debug|info|warn|error>` -- adjust verbosity (respects `MCPORTER_LOG_LEVEL`).
- `--tail-log` -- stream the last 20 lines of any log files referenced by the tool response.
- `--output <format>` or `--raw` -- control formatted output (defaults to pretty-printed auto detection).
- `--all-parameters` -- show every schema field when listing a server (default output shows at least five parameters plus a summary of the rest).
- `--http-url <https://…>` / `--stdio "command …"` -- describe an ad-hoc MCP server inline (pair with `--env KEY=value`, `--cwd`, `--name`, and `--persist <config.json>` as needed). These flags now work with `mcporter auth` too, so `mcporter auth https://mcp.example.com/mcp` just works.
- For OAuth-protected servers such as `vercel`, run `npx mcporter auth vercel` once to complete login.

> Tip: You can skip the verb entirely—`mcporter firecrawl` automatically runs `mcporter list firecrawl`, and dotted tokens like `mcporter linear.list_issues` dispatch to the call command (typo fixes included).

Timeouts default to 30 s; override with `MCPORTER_LIST_TIMEOUT` or `MCPORTER_CALL_TIMEOUT` when you expect slow startups.

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


## Friendlier Tool Calls

- **Function-call syntax.** Instead of juggling `--flag value`, you can call tools as `mcporter call 'linear.create_issue(title: "Bug", team: "ENG")'`. The parser supports nested objects/arrays, lets you omit labels when you want to rely on schema order (e.g. `mcporter 'context7.resolve-library-id("react")'`), and surfaces schema validation errors clearly. Deep dive in [docs/call-syntax.md](docs/call-syntax.md).
- **Flag shorthand still works.** Prefer CLI-style arguments? Stick with `mcporter linear.create_issue title=value team=value`, `title=value`, `title:value`, or even `title: value`—the CLI now normalizes all three forms.
- **Cheatsheet.** See [docs/tool-calling.md](docs/tool-calling.md) for a quick comparison of every supported call style (auto-inferred verbs, flags, function-calls, and ad-hoc URLs).
- **Auto-correct.** If you typo a tool name, mcporter inspects the server’s tool catalog, retries when the edit distance is tiny, and otherwise prints a `Did you mean …?` hint. The heuristic (and how to tune it) is captured in [docs/call-heuristic.md](docs/call-heuristic.md).
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

> The tap publishes alongside mcporter 0.3.0. If you run into issues with an older tap install, run `brew update` before reinstalling.

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

`callOnce` automatically discovers the selected server (including Cursor/Claude/Codex/Windsurf/VS Code imports), handles OAuth prompts, and closes transports when it finishes. It is ideal for manual runs or wiring mcporter directly into an agent tool hook.

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

## Generate a Standalone CLI

Turn any server definition into a shareable CLI artifact:

```bash
npx mcporter generate-cli \
  --command https://mcp.context7.com/mcp

# Outputs:
#   context7.ts        (TypeScript template with embedded schemas)
#   context7.js        (bundled CLI via esbuild)
#   context7.js.metadata.json
```

- `--name` overrides the inferred CLI name.
- Add `--description "..."` if you want a custom summary in the generated help output.
- Add `--bundle [path]` to emit an esbuild bundle alongside the template.
- `--output <path>` writes the template somewhere specific.
- `--runtime bun|node` picks the runtime for generated code (Bun required for `--compile`).
- Add `--compile` to emit a Bun-compiled binary; mcporter cleans up intermediate bundles when you omit `--bundle`.

Every artifact is paired with metadata capturing the generator version, resolved server definition, and invocation flags. Use:

```
npx mcporter inspect-cli dist/context7.js     # human-readable summary
npx mcporter regenerate-cli dist/context7.js  # replay with latest mcporter
```

## Configuration Reference

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
		}
	},
	"imports": ["cursor", "claude-code", "claude-desktop", "codex"]
}
```

What mcporter handles for you:

- `${VAR}`, `${VAR:-fallback}`, and `$env:VAR` interpolation for headers and env entries.
- Automatic OAuth token caching under `~/.mcporter/<server>/` unless you override `tokenCacheDir`.
- Stdio commands inherit the directory of the file that defined them (imports or local config).
- Import precedence matches the array order; omit `imports` to use the default `["cursor", "claude-code", "claude-desktop", "codex"]`.

Provide `configPath` or `rootDir` to CLI/runtime calls when you juggle multiple config files side by side.

## Testing and CI

| Command | Purpose |
| --- | --- |
| `pnpm check` | Biome formatting plus Oxlint/tsgolint gate. |
| `pnpm build` | TypeScript compilation (emits `dist/`). |
| `pnpm test` | Vitest unit and integration suites (streamable HTTP fixtures included). |

CI runs the same trio via GitHub Actions.

## License

MIT -- see [LICENSE](LICENSE).

Further reading: [docs/tool-calling.md](docs/tool-calling.md), [docs/call-syntax.md](docs/call-syntax.md), [docs/adhoc.md](docs/adhoc.md).
