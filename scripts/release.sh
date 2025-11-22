#!/usr/bin/env bash
set -euo pipefail

# mcporter release helper
# - Runs under the guardrail runner by default (MCP_RUNNER or ./runner)
# - Organized into phases so you can resume after fixing an issue: gates, artifacts, publish, smoke, tag
# - Stops on the first error (set -euo pipefail)

RUNNER="${MCP_RUNNER:-./runner}"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}" 

banner() { printf "\n==== %s ====" "$1"; printf "\n"; }
run() { echo ">> $*"; "$@"; }

phase_gates() {
  banner "Gates (lint/type/test/build)"
  run "$RUNNER" pnpm check
  run "$RUNNER" pnpm test
  run "$RUNNER" pnpm build
  run "$RUNNER" pnpm build:bun
}

phase_artifacts() {
  banner "Artifacts (tarball + checksums)"
  local bun_tar="dist-bun/mcporter-macos-arm64-v${VERSION}.tar.gz"
  run tar -C dist-bun -czf "$bun_tar" mcporter
  run shasum -a 256 "$bun_tar" | tee "${bun_tar}.sha256"

  run "$RUNNER" npm pack --pack-destination /tmp
  mv "/tmp/mcporter-${VERSION}.tgz" .
  run shasum "mcporter-${VERSION}.tgz" > "mcporter-${VERSION}.tgz.sha1"
  run shasum -a 256 "mcporter-${VERSION}.tgz" > "mcporter-${VERSION}.tgz.sha256"
}

phase_publish() {
  banner "Publish to npm"
  run "$RUNNER" pnpm publish --tag latest
  run "$RUNNER" npm view mcporter version
  run "$RUNNER" npm view mcporter time
}

phase_smoke() {
  banner "Smoke test in empty dir"
  local tmp=/tmp/mcporter-empty
  rm -rf "$tmp" && mkdir -p "$tmp"
  ( cd "$tmp" && npx mcporter@"$VERSION" generate-cli "npx -y chrome-devtools-mcp" --compile && ./chrome-devtools-mcp --help | head -n 5 )
}

phase_tag() {
  banner "Tag and push"
  git tag "v${VERSION}"
  git push --tags
}

usage() {
  cat <<'EOF'
Usage: scripts/release.sh [phase]

Phases (run individually or all):
  gates      pnpm check, test, build, build:bun
  artifacts  tar + shasum for bun binary; npm pack + shasums
  publish    pnpm publish --tag latest, verify npm view
  smoke      empty-dir npx compile + help banner
  tag        git tag v<version> && push tags
  all        run everything in order

Environment:
  MCP_RUNNER (default ./runner) - guardrail wrapper
  VERSION    (default from package.json)
EOF
}

main() {
  local phase="${1:-all}"
  case "$phase" in
    gates) phase_gates ;;
    artifacts) phase_artifacts ;;
    publish) phase_publish ;;
    smoke) phase_smoke ;;
    tag) phase_tag ;;
    all) phase_gates; phase_artifacts; phase_publish; phase_smoke; phase_tag ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"
