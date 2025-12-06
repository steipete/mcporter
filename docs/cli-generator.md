---
summary: 'Goals and requirements for mcporter generate-cli, including outputs, runtimes, and schema-aware UX.'
read_when:
  - 'Changing generate-cli behavior or bundler integrations'
---

# CLI Generator Plan

Default behavior: generating `<server>.ts` in the working directory if no output path is provided. Bundling is opt-in via `--bundle` and produces a single JS file with shebang; otherwise we emit TypeScript targeting Node.js. Rolldown handles bundling by default unless the runtime resolves to Bun—in that case Bun’s native bundler is selected automatically (still requires `--runtime bun` or Bun auto-detection); `--bundler` lets you override either choice.

## Goal
Create an `mcporter generate-cli` command that produces a standalone CLI for a single MCP server. The generated CLI should feel like a Unix tool: subcommands map to MCP tools, arguments translate to schema fields, and output can be piped/redirected easily.

## High-Level Requirements
- **Input**: Identify the target server either by shorthand name or by providing an explicit MCP server definition.
- **Output**: Emit a TypeScript file (ESM) targeting Node.js by default (`<server>.ts` unless `--output` overrides). Bundling to a standalone JS file happens only when `--bundle` is passed.
- **Runtime Selection**: Prefer Bun when it is available (`bun --version` succeeds); otherwise fall back to Node.js. Callers can force either runtime via `--runtime bun|node`.
- **Schema-Aware CLI**: Leverage `createServerProxy` to map positional/flag arguments to MCP tool schemas, including defaults and required validation.
- **Unix-Friendly Output**: Provide `--output text|json|markdown|raw` flags so results can be piped; default to human-readable text. Include `--timeout` (default 30s) to cap call duration.
- **Shell Completion (optional)**: Generate completion scripts for bash/zsh/fish if requested.
- **Documentation**: Update README (or similar) to show how to generate and use the CLI.

## Steps
1. **Command Scaffolding**
   - Add `generate-cli` subcommand to the existing CLI.
   - Parse flags: `--server`, `--name`, `--command`, optional `--description`, plus `--output`, `--runtime=node|bun`, `--bundle`, `--bundler=rolldown|bun`, `--minify`, `--compile`, `--include-tools`, `--exclude-tools`, etc. Runtime auto-detects Bun when available, and the bundler inherits that choice unless overridden.
   - Optional `--include-tools` / `--exclude-tools` flags allow generating a CLI that exposes only a subset of tools (mutually exclusive).
2. **Server Resolution**
   - If `--server` matches a configured name (via `loadServerDefinitions`), use that server definition.
   - Otherwise, if the value looks like a file path, load a Cursor-style JSON definition from disk.
   - Otherwise, attempt to parse inline JSON/JSON5.
   - When `--command` (or the first positional argument) looks like a shell command (contains whitespace), split it into `command` + `args` and treat it as stdio. Otherwise, normalize HTTP selectors (`https://`, `http://`, or `host/path.tool`) so `generate-cli mcp.context7.com/mcp` autoconfigures an HTTP transport.
   - Validate that a definition is found; prompt on failure.
3. **Tool Introspection**
   - Use `listTools(server, { includeSchema: true })` to inspect MCP tool schemas.
   - For each tool, extract required/optional arguments, types, and defaults.
4. **Template Generation**
   - Build a template (probably EJS or string interpolation) that:
     - Imports `createRuntime` and `createServerProxy`.
     - Creates a CLI (likely using `commander` or a minimal custom parser) with subcommands per tool.
     - Bakes in server metadata (command/url, headers, etc.) or references config path if preferred.
     - Adds output-format handling.
   - Include `package.json` scaffolding if `--bundle` or `--package` is set.
5. **Optional Bundling**
   - If requested, run Rolldown (default when targeting Node) or Bun’s bundler (default when the runtime is Bun, or when `--bundler bun` is passed) to emit a single JS file with shebang (Node or Bun), with optional minification.
   - When targeting Bun, allow `--compile` to delegate to `bun build --compile` and generate a self-contained binary. Bun bundling requires staging the template inside the package tree so dependencies resolve even when invoked from empty directories.
   - Otherwise, leave as TypeScript/ESM and document how to run (`node path/to/cli.js` or `bun path/to/cli.ts`).
6. **Testing**
   - Add generator unit tests (snapshot the emitted CLI for known schemas).
   - Add integration tests that run the generated script against a mock MCP server.
7. **Docs/Examples**
   - Document usage in README.
   - Provide an example generated CLI under `examples/generated/<server>.ts` (if we keep an examples directory).

## Notes
- Generated CLI depends on the latest `commander` for argument parsing.
- Default timeout for tool calls is 30 seconds, overridable via `--timeout`.
- Runtime flag remains (`--runtime bun`) to tailor shebang/usage instructions, but Node.js is the default.
- Generated CLI embeds the resolved server definition and always targets that snapshot (no external `--config` or `--server` overrides at runtime).

## Usage Examples

```bash
# Minimal: infer the name from the command URL and emit TypeScript (optionally bundle)
npx mcporter generate-cli \
  --command https://mcp.context7.com/mcp \
  --minify

# Provide explicit name/description and compile a Bun binary (falls back to Node if Bun missing)
npx mcporter generate-cli \
  --name context7 \
  --command https://mcp.context7.com/mcp \
  --description "Context7 docs MCP" \
  --runtime bun \
  --compile

chmod +x context7
./context7
  # show the embedded help + tool list

# Shareable "one weird trick" for chrome-devtools (no config required)
npx mcporter generate-cli --command "npx -y chrome-devtools-mcp@latest"

- `--minify` shrinks the bundled output via the selected bundler (output defaults to `<server>.js`).
- `--compile [path]` implies bundling and invokes `bun build --compile` to create the native executable (Bun only). When you omit the path, the compiled binary inherits the server name.
- Use `--server '{...}'` when you need advanced configuration (headers, env vars, stdio commands, OAuth metadata).
- Omit `--name` to let mcporter infer it from the command URL (for example, `https://mcp.context7.com/mcp` becomes `context7`).
- When targeting an existing config entry, you can skip `--server` and pass the name as a positional argument:
  `npx mcporter generate-cli linear --bundle dist/linear.js`.
- When the MCP server is a stdio command, you can also skip `--command` by quoting the inline command as the first positional argument (e.g., `npx mcporter generate-cli "npx -y chrome-devtools-mcp@latest"`).
- Narrow the CLI to a specific subset of tools with `--include-tools`:
  `npx mcporter generate-cli linear --include-tools issues_list,issues_create`.
- Hide debug or admin tools with `--exclude-tools`:
  `npx mcporter generate-cli linear --exclude-tools debug_tool,admin_reset`.
```



## Artifact Metadata & Regeneration

- Every generated artifact embeds its metadata (generator version, resolved server definition, invocation flags). A hidden `__mcporter_inspect` subcommand prints the payload without contacting the MCP server, so binaries remain self-describing even after being copied to another machine.
- `mcporter inspect-cli <artifact>` shells out to that embedded command and prints a human summary (pass `--json` for raw output). The summary includes a ready-to-run `generate-cli` command you can reuse directly.
- `mcporter generate-cli --from <artifact>` replays the stored invocation against the latest mcporter build. `--server`, `--runtime`, `--timeout`, `--minify/--no-minify`, `--bundle`, `--compile`, `--output`, and `--dry-run` let you override specific pieces of the stored metadata when necessary.
- Because the metadata lives inside the artifact, any template, bundle, or compiled binary can be refreshed after a generator upgrade without juggling sidecar files.



## Status
- ✅ `generate-cli` subcommand implemented with schema-aware proxy generation.
- ✅ Inline JSON / file / shorthand server resolution wired up.
- ✅ Bundling via Rolldown by default (or Bun automatically when the runtime is Bun, with `--bundler` available for overrides) plus optional minification and Bun bytecode compilation.
- ✅ Integration tests cover bundling, minification, compiled binaries, and metadata/regeneration flows against the mock MCP server.

Next steps:
1. Add optional shell completion scaffolding if demand arises.
2. Explore templated TypeScript definitions for generated CLIs to improve editor tooling.
