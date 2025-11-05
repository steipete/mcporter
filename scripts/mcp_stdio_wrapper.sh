#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "mcp_stdio_wrapper.sh: missing command" >&2
  exit 1
fi

exec "$@"
