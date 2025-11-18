---
title: Windows & WSL tips
summary: What to do when pnpm/test flows fail on NTFS-backed worktrees.
---

## Installing dependencies

* `pnpm install` fails on `/mnt/c` because NTFS/DrvFs blocks `futime`. Clone/sync the repo to `$HOME` (ext4 inside WSL) and run `./runner pnpm install` there instead. Example: `rsync -a --delete --exclude node_modules /mnt/c/Projects/mcporter/ ~/mcporter-wsl/`.
* Keep `$HOME/.bun/bin` and `$HOME/.local/share/pnpm` on your PATH before invoking `./runner`. Without Bun and pnpm the runner prints the guardrail error and exits.
* If you *must* work from `/mnt/c`, remount with `metadata` support (`sudo mount -t drvfs C: /mnt/c -o metadata,uid=$(id -u),gid=$(id -g),umask=22,fmask=111`). Otherwise installs, chmods, and copyfile calls will continue to fail.

## Running tests

* Use the ext4 copy (`~/mcporter-wsl`) for `pnpm lint`, `pnpm typecheck`, and the Vitest suites. All tests pass there (71 files / 280 tests, 1 file and 2 tests skipped).
* Whole-repo `pnpm test` on `/mnt/c` repeatedly times out because Vitest cannot start workers when the node_modules tree belongs to root or sits on NTFS. Copy the repo to ext4 or fix ownership before retrying.
* When working cross-filesystem, remember to sync the edited source files back to the canonical `/mnt/c/Projects/mcporter` tree (e.g., `rsync -a ~/mcporter-wsl/src/cli/generate/{template,artifacts,fs-helpers}.ts /mnt/c/Projects/mcporter/src/cli/generate/`).
* The stdio integration suite now vendors two tiny fixtures under `tests/fixtures/stdio-*.mjs` that spin up filesystem/memory MCP servers via `node`. The tests shell out to `process.execPath`, so make sure your PATH resolves `node` correctly (fnm/nvs setups sometimes expose only `node.exe` on Windows). If you need to debug them manually, run `./runner pnpm exec vitest run tests/stdio-servers.integration.test.ts` so the guardrails apply.

## Windows-specific fixes in the repo

* CLI generation now uses `src/cli/generate/fs-helpers.ts`: `markExecutable` ignores `EPERM/EINVAL/ENOSYS/EACCES` so NTFS builds no longer fail when setting executable bits.
* `safeCopyFile` falls back to a manual read/write when DrvFs blocks `copyFile`, keeping Bun bundling stable on Windows.
* These helpers only affect Windows/WSL behavior—Linux/macOS paths still perform real `chmod`/`copyFile`.
* Regenerated CLIs (for example `node dist/cli.js generate-cli context7 --config config/mcporter.json --bundle /mnt/c/Temp/context7-cli.js --runtime node`) now complete successfully even when the bundle lives on `/mnt/c`, and the resulting executable runs with `node /mnt/c/Temp/context7-cli.js --help`.
* When running `mcporter generate-cli` with `--command ./relative-script.ts`, the CLI no longer tries to normalize the path into an HTTP URL—relative/bare commands are always treated as STDIO transports now, matching the PowerShell/WSL behavior you expect.
