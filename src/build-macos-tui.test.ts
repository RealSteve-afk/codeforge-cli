import fs from 'fs'
import path from 'path'

it('documents a bun darwin-arm64 compile to dist/codeforge', () => {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/build-macos-tui.sh'), 'utf8')
  expect(script.startsWith('#!/usr/bin/env bash')).toBe(true)
  expect(script).toMatch(/set -euo pipefail/)
  expect(script).toMatch(/bun-darwin-arm64/)
  expect(script).toMatch(/dist\/codeforge/)
  expect(script).toMatch(/command -v bun/)
})
