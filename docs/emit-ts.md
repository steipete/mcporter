# `mcporter emit-ts`

`mcporter emit-ts` turns a configured MCP server into TypeScript artifacts so
agents, tests, and tooling can consume the server through strongly typed APIs.
It reuses the same `buildToolDoc()` data that powers `mcporter list`, so doc
comments, parameter hints, and signatures stay perfectly in sync. For a broader
overview of every CLI command, see `docs/cli-reference.md`.

```
mcporter emit-ts <server> --out linear-client.ts \
  [--mode types|client] \
  [--include-optional]
```

- `--mode types` (default) emits a `.d.ts` interface (`LinearTools`) with
docblocks + promisified signatures. Missing output schemas fall back to
`CallResult`.
- `--mode client` emits both the interface (auto-derived `.d.ts`) **and** an
executable `.ts` helper that wraps `createServerProxy`. Each method returns a
`CallResult`, and the factory exposes a `close()` helper for runtimes the client
creates.
- `--include-optional` mirrors `mcporter list --all-parameters`, ensuring every
parameter is shown even when optional.

Outputs overwrite existing files automatically so you can regenerate artifacts
whenever the server schema changes.

## Examples

### 1. Types-only header

```
mcporter emit-ts linear --out types/linear-tools.d.ts
```

Produces:

```ts
import type { CallResult } from 'mcporter';

export interface LinearTools {
  /**
   * List comments for a specific Linear issue.
   *
   * @param issueId The issue ID
   */
  list_comments(params: { issueId: string }): Promise<CallResult>;
}
```

Include the file in your agent/project and you can type-check code like
`const result = await proxy.list_comments({ issueId: '...' });`.

### 2. Client wrappers

```
mcporter emit-ts linear --mode client --out clients/linear.ts
```

Generates two files:

- `clients/linear.d.ts` – same interface as the types-only mode.
- `clients/linear.ts` – imports `createRuntime`, `createServerProxy`, and
  `createCallResult`, then exposes a `createLinearClient()` factory:

```ts
const client = await createLinearClient({ configPath: './mcporter.json' });
const comments = await client.list_comments({ issueId: 'LIN-1234' });
console.log(comments.text());
await client.close();
```

If you pass an existing runtime (`{ runtime }`), the factory reuses it; the
returned object’s `close()` becomes a no-op.

## Flags

| Flag | Description |
| --- | --- |
| `--out <path>` | Required. `.d.ts` target for `types`, `.ts` target for `client`. |
| `--mode types|client` | Output kind (defaults to `types`). |
| `--types-out <path>` | Optional override for the `.d.ts` file when `--mode client`. Default: derive from `--out`. |
| `--include-optional` | Include every parameter (not just the minimum 5 + required). |
| `--json` | Emit a JSON summary describing the emitted file(s) instead of plain-text logs. |

## Testing

`tests/emit-ts.test.ts` covers:

- Template rendering (doc comments, `Promise<…>` return types, proxy wrappers).
- End-to-end CLI invocation with a stub runtime, ensuring both `.ts` and `.d.ts`
  files are written successfully.
