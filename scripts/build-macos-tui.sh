#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to compile the macOS TUI" >&2
  exit 1
fi
mkdir -p dist
bun build --compile --target=bun-darwin-arm64 src/main.ts --outfile dist/codeforge
chmod +x dist/codeforge
test -x dist/codeforge
echo "wrote $(pwd)/dist/codeforge"
