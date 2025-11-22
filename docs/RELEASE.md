# Release Checklist

> **Runner note:** From the repo root run `export MCP_RUNNER="$PWD/runner"` and use `$MCP_RUNNER <command>` for every shell command listed below unless the step explicitly says otherwise. This keeps the guardrails active even when the checklist jumps between directories.

> **No-warning policy:** Every command below must finish without warnings (Biome, Oxlint, tsgo, Vitest, npm pack, etc.). Fix issues before continuing; releases cannot ship with outstanding warnings.

1. Update version in package.json and src/runtime.ts.
2. Run pnpm install to refresh the lockfile if dependencies changed.
3. pnpm check (zero warnings allowed; abort immediately on any error)
4. pnpm test (must finish with **0 failed**; if Vitest prints any red FAIL lines or a non-zero exit code, stop and fix it before proceeding)
5. pnpm build
6. pnpm build:bun
7. tar -C dist-bun -czf dist-bun/mcporter-macos-arm64-v<version>.tar.gz mcporter
8. shasum -a 256 dist-bun/mcporter-macos-arm64-v<version>.tar.gz | tee dist-bun/mcporter-macos-arm64-v<version>.tar.gz.sha256
9. npm pack --pack-destination /tmp && mv /tmp/mcporter-<version>.tgz .  # keep the real tarball
10. shasum mcporter-<version>.tgz > mcporter-<version>.tgz.sha1 && shasum -a 256 mcporter-<version>.tgz > mcporter-<version>.tgz.sha256
11. Verify git status is clean.
11. git commit && git push.
12. pnpm publish --tag latest *(the runner already has npm credentials configured, so you can run this directly in the release shell; bump `timeout_ms` if needed because prepublish re-runs check/test/build and can take several minutes.)*
13. `npm view mcporter version` (and `npm view mcporter time`) to ensure the registry reflects the new release before proceeding. If the new version isn’t visible yet, wait a minute and retry—npm’s replication can lag briefly.
14. Sanity-check the “one weird trick” workflow from a **completely empty** directory (no package.json/node_modules) via:
    ```bash
    rm -rf /tmp/mcporter-empty && mkdir -p /tmp/mcporter-empty
    cd /tmp/mcporter-empty
    # run this without the runner because we are outside the repo and npx handles its own logging
    npx mcporter@<version> generate-cli "npx -y chrome-devtools-mcp" --compile
    ./chrome-devtools-mcp --help | head -n 5
    ```
    Only continue once the CLI compiles and the help banner prints.
15. Draft the GitHub release notes using this template (copy/paste and edit):
    ```markdown
    ## Highlights
    - <top feature>
    - <second feature>
    - <bugfix or UX callout>

    SHA256 (mcporter-macos-arm64-v<version>.tar.gz): `<sha from step 8>`
    SHA256 (mcporter-<version>.tgz): `<sha from npm pack>`
    ```
    Then **create the GitHub release for tag v<version>** and upload all assets:
    - `mcporter-macos-arm64-v<version>.tar.gz`
    - `mcporter-macos-arm64-v<version>.tar.gz.sha256` (from step 8; add a `.sha256` file)
    - `mcporter-<version>.tgz` (from `npm pack`)
    - `mcporter-<version>.tgz.sha1` and `mcporter-<version>.tgz.sha256`
    Double-check the uploaded checksums match your local files.
16. Tag the release (git tag v<version> && git push --tags).
17. Post-tag housekeeping: add a fresh "Unreleased" stub to CHANGELOG.md (set to "- Nothing yet.") and start a new version section for the just-released patch if it isn’t already recorded.

After the release is live, always update the Homebrew tap and re-verify both installers. That flow should be:

1. Uninstall any existing `mcporter` binaries to avoid PATH conflicts:
   ```bash
   brew uninstall mcporter || true
   npm uninstall -g mcporter || true
   ```
2. Install from Homebrew, run `brew test` equivalents (`mcporter list --help`), then uninstall so the npm install owns the global `mcporter` binary. If the install fails with a linking conflict (`bin/mcporter already exists`), run `brew link --overwrite mcporter` and rerun the smoke command before uninstalling:
   ```bash
   brew install steipete/tap/mcporter
   # If you still have /opt/homebrew/bin/mcporter from npm, fix conflicts with:
   # brew link --overwrite mcporter
   mcporter list --help | head -n 5
   brew uninstall mcporter
   ```
3. Install the npm package globally (or leave it to npx) and keep that version in place for day-to-day use:
   ```bash
   npm install -g mcporter@<version>
   mcporter --version
   ```
4. Finally, run a fresh `npx mcporter@<version>` smoke test from an empty temp directory (no runner needed) to ensure the package is usable without global installs.

17. Update `steipete/homebrew-tap` → `Formula/mcporter.rb` with the new version, tarball URL, and SHA256. Refresh the tap README highlights and changelog snippets so Homebrew users see the new version callouts. (That repo doesn’t include `runner`, so use regular git commands there.)
18. Commit and push the tap update.
19. Verify the Homebrew flow (after GitHub release assets propagate):
    ```bash
    brew update
    brew install steipete/tap/mcporter
    # If you previously installed mcporter via npm (or another tap) and see a link error,
    # run `brew link --overwrite mcporter` to replace /opt/homebrew/bin/mcporter with the tap binary.
    mcporter list --help
    ```
