#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')

const pkgPath = path.join(__dirname, '..', 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
let changed = false
for (const name of Object.keys(pkg.optionalDependencies || {})) {
  if (!name.startsWith('@realsteve-afk/codeforge-pager-')) continue
  if (pkg.optionalDependencies[name] !== pkg.version) {
    pkg.optionalDependencies[name] = pkg.version
    changed = true
  }
}
if (changed) {
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  process.stdout.write(`codeforge: pager optionalDependencies -> ${pkg.version}\n`)
}
