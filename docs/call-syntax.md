# Call Syntax Reference

`mcporter call` now understands two complementary styles:

| Style | Example | Notes |
|-------|---------|-------|
| Flag-based (compatible) | `mcporter call linear.create_comment --issue-id LNR-123 --body "Hi"` | Use `key=value`, `key:value`, or `key: value` pairs—ideal for shell scripts. |
| Function-call (expressive) | `mcporter call 'linear.create_comment(issueId: "LNR-123", body: "Hi")'` | Mirrors the pseudo-TypeScript signature shown by `mcporter list`; unlabeled values map to schema order. |
| Structured output | `mcporter call 'linear.create_comment(...)' --output json` | Successful calls emit JSON bodies; failures emit `{ server, tool, issue }` envelopes so automation can react to auth/offline/http errors. |

Both forms share the same validation pipeline, so required parameters, enums, and formats behave identically.

## Reading the CLI Signatures

`mcporter list <server>` prints each tool as a compact TypeScript declaration:

```ts
/**
 * Create a comment on a specific Linear issue.
 * @param issueId The issue ID
 * @param body The content of the comment as Markdown
 * @param parentId? A parent comment ID to reply to
 */
function create_comment(issueId: string, body: string, parentId?: string): Comment;
// optional (3): notifySubscribers, labelIds, mentionIds, ...
```

Key details:

- Doc blocks use `@param` lines so every parameter description (even optional ones) stays in view.
- Required parameters appear without `?`; optional parameters use `?` and inherit enum literals (e.g. `"json" | "markdown"`).
- Known format hints are appended inline: `dueDate?: string /* ISO 8601 */` (we suppress the hint when the description already calls it out).
- When a tool exposes more than two optional parameters (or has ≥4 required parameters), the default output hides the extras and replaces them with an inline summary like `// optional (8): limit, before, after, orderBy, projectId, ...`.
- Run `mcporter list <server> --all-parameters` whenever you want the full signature; the footer repeats `Optional parameters hidden; run with --all-parameters to view all fields.` any time truncation occurs.
- Return types come from each tool’s output schema, so you’ll see concrete names when providers include `title` metadata (e.g. `DocumentConnection`). When no schema is advertised we omit the `: Type` suffix entirely instead of showing `unknown`.
- Each server concludes with a short `Examples:` block that mirrors the preferred function-call syntax.

## Function-Call Syntax Details

- **Named arguments preferred**: `issueId: "123"` keeps calls self-documenting. When labels are omitted, mcporter falls back to positional order defined by the tool schema.
- **Optional positional fallback**: omit labels when calling `mcporter 'context7.resolve-library-id("react")'`—arguments map to the schema order after any explicitly named parameters.
- **Literals supported**: strings, numbers, booleans, `null`, arrays, and nested objects. For strings containing spaces or commas, wrap the entire call in single quotes to keep the shell happy.
- **Error feedback**: invalid keys, unsupported expressions, or parser failures bubble up with actionable messages (`Unsupported argument expression: Identifier`, `Unable to parse call expression: …`).
- **Server selection**: You can embed the server in the expression (`linear.create_comment(...)`) or pass it separately (`--server linear create_comment(...)`).

## HTTP Selectors & Ad-hoc URLs

- You can skip `--server` entirely by pasting the MCP endpoint + tool name directly: `mcporter call 'https://www.shadcn.io/api/mcp.getComponent(component: "vortex")'`.
- Mcporter strips the `.tool` suffix to derive the base server URL, reuses any configured definition that already points at that endpoint, and only registers a new ad-hoc server when necessary (`--allow-http` still guards plain HTTP URLs).
- Function-call arguments continue to work in this form; if you omit parentheses you can still append `key=value` pairs (`https://.../mcp.getComponent component=vortex`).
- This is especially handy for copy/pasting tool listings or experimenting with anonymous HTTP MCP servers—you get the same parsing, auto-correction, and logging pipeline as the regular `server.tool` syntax.
- Protocols are optional; bare domains such as `shadcn.io/api/mcp.getComponents` automatically assume `https://`. If you really need plain HTTP, spell out `http://` and pass `--allow-http`.
- Hostname comparisons ignore a leading `www.` so `https://shadcn.io/api/mcp` and `https://www.shadcn.io/api/mcp` resolve to the same configured server when possible.

## Tips

- Use `--args '{ "issueId": "LNR-123" }'` if you already have JSON payloads—nothing changed for that workflow.
- The new syntax respects all existing features (timeouts, `--output`, auto-correction).
- Required fields show by default; pass `--all-parameters` when you want the full parameter list (or `--schema` for raw JSON schemas).
- When in doubt, run `mcporter list <server>` to see the current signature and sample invocation.

## Flag-Based Syntax Details

- `key=value`, `key:value`, and `key: value` all map to the same named-argument handling, so you can type whichever feels most natural for your shell.
- Arguments keep the same validation pipeline as the function-call syntax—enums, numbers, and booleans are coerced automatically, and missing required fields raise errors.
- `tool=value`/`tool:value` and `server=value` still act as aliases for `--tool` / `--server` when you need to override the selector.
