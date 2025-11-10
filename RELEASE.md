# Release Checklist

> **No-warning policy:** Every command below must finish without warnings (Biome, Oxlint, tsgo, Vitest, npm pack, etc.). Fix issues before continuing; releases cannot ship with outstanding warnings.

1. Update version in package.json and src/runtime.ts.
2. Run pnpm install to refresh the lockfile if dependencies changed.
3. pnpm check (zero warnings allowed; abort immediately on any error)
4. pnpm test (must finish with **0 failed**; if Vitest prints any red FAIL lines or a non-zero exit code, stop and fix it before proceeding)
5. pnpm build
6. pnpm build:bun
7. tar -C dist-bun -czf dist-bun/mcporter-macos-arm64-v<version>.tar.gz mcporter
8. shasum -a 256 dist-bun/mcporter-macos-arm64-v<version>.tar.gz
9. npm pack --dry-run to inspect the npm tarball.
10. Verify git status is clean.
11. git commit && git push.
12. pnpm publish --tag latest *(allow plenty of time—prepublish re-runs check/test/build and can take several minutes. When using the runner, bump `timeout_ms` or run the command directly in a normal shell so it doesn't abort mid-run.)*
13. `npm view mcporter version` (and `npm view mcporter time`) to ensure the registry reflects the new release before proceeding.
14. Sanity-check the “one weird trick” workflow from a **completely empty** directory (no package.json/node_modules) via:
    ```bash
    rm -rf /tmp/mcporter-empty && mkdir -p /tmp/mcporter-empty
    cd /tmp/mcporter-empty
    npx mcporter@<version> generate-cli "npx -y chrome-devtools-mcp" --compile
    ./chrome-devtools-mcp --help | head -n 5
    ```
    Only continue once the CLI compiles and the help banner prints.
15. Create a GitHub release, upload mcporter-macos-arm64-v<version>.tar.gz (with the SHA from step 8), and record the release URL. Double-check the uploaded checksum matches step 8.
16. Tag the release (git tag v<version> && git push --tags).
17. Update `steipete/homebrew-tap` → `Formula/mcporter.rb` with the new version, tarball URL, and SHA256. Refresh the tap README highlights and changelog snippets so Homebrew users see the new version callouts.
18. Commit and push the tap update.
19. Verify the Homebrew flow (after GitHub release assets propagate):
    ```bash
    brew update
    brew install steipete/tap/mcporter
    mcporter list --help
    ```
