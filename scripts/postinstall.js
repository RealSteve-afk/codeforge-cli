#!/usr/bin/env node

const { installPager } = require('./install-pager')
const { installCliPath } = require('./ensure-cli-path')

try {
  installCliPath()
} catch (error) {
  process.stdout.write(`codeforge: path setup skipped (${error instanceof Error ? error.message : String(error)})\n`)
}

installPager().then(
  (result) => {
    if (result.ok) {
      if (!result.skipped) process.stdout.write(`codeforge: pager -> ${result.dest}\n`)
      else if (result.reason) process.stdout.write(`codeforge: ${result.reason}\n`)
      process.exit(0)
    }
    process.stderr.write(`codeforge: ${result.reason || 'pager install failed'}\n`)
    process.stderr.write('codeforge: native TUI is required; re-run npm install -g @realsteve-afk/codeforge-cli\n')
    process.exit(1)
  },
  (error) => {
    process.stderr.write(`codeforge: pager install failed (${error instanceof Error ? error.message : String(error)})\n`)
    process.exit(1)
  },
)
