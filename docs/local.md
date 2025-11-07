# Running mcporter Locally

You don’t need `npx` every time—here are the three local entry points we use while developing mcporter itself.

## 1. Direct TypeScript entry (no build step)

All commands can be executed with `tsx` straight from `src/cli.ts`:

```bash
# list servers (text)
pnpm exec tsx src/cli.ts list

# list servers as JSON
pnpm exec tsx src/cli.ts list --json

# call a tool (auto formatted)
pnpm exec tsx src/cli.ts call context7.resolve-library-id libraryName=react

# call a tool but emit structured JSON on success/failure
pnpm exec tsx src/cli.ts call context7.resolve-library-id libraryName=react --output json

# auth flow
pnpm exec tsx src/cli.ts auth vercel

# auth flow with structured JSON status
pnpm exec tsx src/cli.ts auth vercel --json

# ad-hoc auth
pnpm exec tsx src/cli.ts auth https://mcp.supabase.com/mcp
```

These invocations match the `pnpm mcporter:*` scripts and are ideal when you’re iterating on TypeScript without rebuilding.

## 2. Compiled CLI from `dist/`

When you want the same behaviour the published package ships with:

```bash
pnpm build          # emits dist/...
node dist/cli.js list
node dist/cli.js call chrome-devtools.take_snapshot
```

Set flags exactly as you would in production:

```bash
MCPORTER_DEBUG_HANG=1 node dist/cli.js list
MCPORTER_NO_FORCE_EXIT=1 node dist/cli.js call linear.search_documentation query="automations"
```

## 3. Workspace executables

After `pnpm add mcporter` in your project (or inside this repo), the shim binaries are available:

```bash
pnpm mcporter:list
pnpm mcporter:call context7.get-library-docs topic=hooks
```

## Debug flags recap

- `MCPORTER_DEBUG_HANG=1` – dumps active handles around shutdown (pairs well with tmux; see `docs/hang-debug.md`).
- `MCPORTER_NO_FORCE_EXIT=1` – keeps the process alive even after cleanup (useful while inspecting debug output).
- `MCPORTER_FORCE_EXIT=1` – force termination even if the above is set.
- `MCPORTER_STDIO_LOGS=1` – print the buffered stderr output from stdio MCP servers (handy when debugging noisy backends).

All three entry points honour the same `--config`, `--root`, and `--log-level` flags as the published CLI.
