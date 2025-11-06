# Call Syntax Reference

`mcporter call` now understands two complementary styles:

| Style | Example | Notes |
|-------|---------|-------|
| Flag-based (compatible) | `mcporter call linear.create_comment --issue-id LNR-123 --body "Hi"` | Great for shell scripts and backwards compatibility. |
| Function-call (expressive) | `mcporter call 'linear.create_comment(issueId: "LNR-123", body: "Hi")'` | Mirrors the pseudo-TypeScript signature shown by `mcporter list`. |

Both forms share the same validation pipeline, so required parameters, enums, and formats behave identically.

## Reading the CLI Signatures

`mcporter list <server>` now prints each tool like a mini TypeScript snippet:

```ts
// Create a comment on a specific Linear issue
create_comment({
  issueId: string              // The issue ID
  body: string                 // The content of the comment as Markdown
  parentId?: string            // A parent comment ID to reply to
})
```

- Required parameters appear without `?`, optional parameters use `?`.
- Literal unions (enums) render as `"json" | "markdown"`.
- Known formats (e.g. ISO 8601) surface inline: `dueDate?: string /* ISO 8601 */`.
- Each parameter’s schema description is shown as a dimmed `//` comment to match the CLI styling.
- After the tool list you’ll see an `Examples:` block with a few ready-to-run calls; the legacy flag form is still accepted but no longer printed for every tool.

## Function-Call Syntax Details

- **Named arguments only**: `issueId: "123"` is required; positional arguments are rejected so we can reliably map schema names.
- **Literals supported**: strings, numbers, booleans, `null`, arrays, and nested objects. For strings containing spaces or commas, wrap the entire call in single quotes to keep the shell happy.
- **Error feedback**: invalid keys, unsupported expressions, or parser failures bubble up with actionable messages (`Unsupported argument expression: Identifier`, `Unable to parse call expression: …`).
- **Server selection**: You can embed the server in the expression (`linear.create_comment(...)`) or pass it separately (`--server linear create_comment(...)`).

## Tips

- Use `--args '{ "issueId": "LNR-123" }'` if you already have JSON payloads—nothing changed for that workflow.
- The new syntax respects all existing features (timeouts, `--output`, auto-correction).
- When in doubt, run `mcporter list <server>` to see the current signature and sample invocation.
