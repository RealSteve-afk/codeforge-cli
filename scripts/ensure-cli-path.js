#!/usr/bin/env node

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

function isWin(options = {}) {
  return (options.platform || process.platform) === 'win32'
}

function pathDelim(options = {}) {
  if (options.delimiter) return options.delimiter
  return isWin(options) ? ';' : options.platform ? ':' : path.delimiter
}

function pathDirs(pathEnv = process.env.PATH || '', options = {}) {
  return pathEnv.split(pathDelim(options)).filter(Boolean)
}

function normalizePathEntry(dir, options = {}) {
  if (isWin(options)) {
    return String(dir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }
  try {
    return path.resolve(dir)
  } catch {
    return dir
  }
}

function pathContains(dir, pathEnv = process.env.PATH || '', options = {}) {
  const target = normalizePathEntry(dir, options)
  return pathDirs(pathEnv, options).some((entry) => normalizePathEntry(entry, options) === target)
}

function globalCodeForgeBin(options = {}) {
  const win = isWin(options)
  const name = win ? 'codeforge.cmd' : 'codeforge'
  const prefix = options.prefix || process.env.npm_config_prefix || ''
  const fromPrefix = prefix
    ? (win ? path.join(prefix, name) : path.join(prefix, 'bin', name))
    : ''
  const fromLayout = path.resolve(
    options.packageRoot || path.join(__dirname, '..'),
    '..',
    '..',
    win ? name : path.join('bin', name),
  )
  const exists = options.exists || ((file) => fs.existsSync(file))
  for (const candidate of [fromPrefix, fromLayout]) {
    if (candidate && exists(candidate)) return candidate
  }
  return fromPrefix || fromLayout
}

function userLocalBin(home = os.homedir(), options = {}) {
  if (isWin(options)) {
    const localAppData =
      options.localAppData || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return path.join(localAppData, 'codeforge', 'bin')
  }
  return path.join(home, '.local', 'bin')
}

function toGitBashPath(winPath) {
  const normalized = String(winPath).replace(/\\/g, '/')
  const drive = normalized.match(/^([A-Za-z]):\/(.*)$/)
  if (drive) return `/${drive[1].toLowerCase()}/${drive[2]}`
  return normalized
}

function writeShim(dest, body) {
  fs.writeFileSync(dest, body)
  try {
    fs.chmodSync(dest, 0o755)
  } catch {
    
  }
}


function removeShim(dest) {
  try {
    fs.unlinkSync(dest)
    return true
  } catch {
    return !fs.existsSync(dest)
  }
}

function codeforgeHome(options = {}) {
  const override = String(options.codeforgeHome || process.env.CODEFORGE_HOME || '').trim()
  if (override) return override
  return path.join(options.home || os.homedir(), '.codeforge')
}

function ensureLink(target, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 })
  const resolvedTarget = path.resolve(target)
  
  
  
  if (resolvedTarget === dest) return dest
  try {
    if (fs.realpathSync(dest) === fs.realpathSync(resolvedTarget)) return dest
  } catch {
    
  }
  try {
    if (fs.lstatSync(dest)) fs.unlinkSync(dest)
  } catch {
    
  }
  fs.symlinkSync(resolvedTarget, dest)
  try {
    fs.chmodSync(dest, 0o755)
  } catch {
    
  }
  return dest
}

function ensurePrivateNodeShims(options = {}) {
  if (isWin(options)) return []
  const nodeBin = path.join(codeforgeHome(options), 'node', 'bin')
  const node = path.join(nodeBin, 'node')
  const npm = path.join(nodeBin, 'npm')
  const exists = options.exists || ((file) => fs.existsSync(file))
  if (!exists(node) || !exists(npm)) return []
  const destDir = userLocalBin(options.home || os.homedir(), options)
  const shims = [
    ensureLink(node, path.join(destDir, 'node')),
    ensureLink(npm, path.join(destDir, 'npm')),
    ensureLink(npm, path.join(destDir, 'nmp')),
  ]
  const npx = path.join(nodeBin, 'npx')
  if (exists(npx)) shims.push(ensureLink(npx, path.join(destDir, 'npx')))
  return shims
}

function lexists(file) {
  try {
    fs.lstatSync(file)
    return true
  } catch {
    return false
  }
}

function firstLiveBinDir(pathEnv = process.env.PATH || '', options = {}) {
  if (isWin(options)) return ''
  const isDir =
    options.isDir ||
    ((dir) => {
      try {
        return fs.statSync(dir).isDirectory()
      } catch {
        return false
      }
    })
  const writable =
    options.writable ||
    ((dir) => {
      try {
        fs.accessSync(dir, fs.constants.W_OK)
        return true
      } catch {
        return false
      }
    })
  const preferred = ['/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of preferred) {
    if (pathContains(dir, pathEnv, options) && isDir(dir) && writable(dir)) {
      return dir
    }
  }
  const skip = new Set(['/sbin', '/usr/sbin', '/usr/local/sbin', '.', './'])
  for (const dir of pathDirs(pathEnv, options)) {
    if (!dir || skip.has(dir)) continue
    if (isDir(dir) && writable(dir)) return dir
  }
  return ''
}

function ensureLivePathLink(src, name, options = {}) {
  if (isWin(options) || !src) return null
  const dir = firstLiveBinDir(options.pathEnv || process.env.PATH || '', options)
  if (!dir) return null
  const dest = path.join(dir, name)
  const force = name === 'codeforge' || options.forceLiveLink
  if (!force && lexists(dest)) {
    try {
      const target = fs.readlinkSync(dest)
      if (!String(target).startsWith(codeforgeHome(options))) return null
    } catch {
      return null
    }
  }
  return ensureLink(src, dest)
}

function ensureUserShim(target, options = {}) {
  if (!target) return null
  const dir = userLocalBin(options.home || os.homedir(), options)
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
  if (isWin(options)) {
    return writeWindowsWrappers(target, dir, options)
  }
  return ensureLink(target, path.join(dir, 'codeforge'))
}


function writeWindowsWrappers(target, dir, options = {}) {
  const exists = options.exists || ((file) => fs.existsSync(file))
  const cmdTarget = String(target).replace(/"/g, '')
  const cmdDest = path.join(dir, 'codeforge.cmd')
  writeShim(cmdDest, `@echo off\r\ncall "${cmdTarget}" %*\r\n`)

  const shSource = cmdTarget.replace(/\.cmd$/i, '')
  const shTarget = exists(shSource) ? shSource : cmdTarget
  writeShim(path.join(dir, 'codeforge'), `#!/bin/sh\nexec "${toGitBashPath(shTarget).replace(/"/g, '')}" "$@"\n`)
  removeShim(path.join(dir, 'codeforge.ps1'))
  return cmdDest
}


function removePowerShellShim(bin, options = {}) {
  if (!isWin(options) || !bin) return null
  const ps1 = String(bin).replace(/\.cmd$/i, '.ps1')
  if (ps1 === String(bin)) return null
  const exists = options.exists || ((file) => fs.existsSync(file))
  if (!exists(ps1)) return null
  return { path: ps1, removed: removeShim(ps1) }
}

function pathHint(npmBin, localBin, pathEnv = process.env.PATH || '', options = {}) {
  const dirs = []
  if (localBin && !pathContains(localBin, pathEnv, options)) dirs.push(localBin)
  if (npmBin && !pathContains(npmBin, pathEnv, options)) dirs.push(npmBin)
  if (!dirs.length) return ''
  if (isWin(options)) {
    const joined = dirs.join(';')
    const git = dirs.map(toGitBashPath).join(':')
    return [
      `set PATH=${joined};%PATH%`,
      `$env:Path = "${joined};" + $env:Path`,
      `export PATH="${git}:$PATH"`,
    ].join('\n  ')
  }
  return `export PATH="${dirs.join(':')}:$PATH" && hash -r`
}

function readWindowsUserPath() {
  const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const line = out.split(/\r?\n/).find((row) => /\bPath\s+REG_/i.test(row))
  if (!line) return ''
  const match = line.match(/REG_\w+\s+(.*)$/)
  return match ? match[1].trim() : ''
}

function writeWindowsUserPath(value) {
  execFileSync('reg', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', value, '/f'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function persistUserPath(dir, options = {}) {
  if (!isWin(options) || !dir) return { added: false }
  const read = options.readUserPath || readWindowsUserPath
  const write = options.writeUserPath || writeWindowsUserPath
  const current = String(read() || '')
  if (pathContains(dir, current, options)) return { added: false }
  const next = current ? `${current.replace(/;+$/, '')};${dir}` : dir
  write(next)
  return { added: true }
}

function installCliPath(options = {}) {
  const writes = options.write || ((text) => process.stdout.write(text))
  const bin = globalCodeForgeBin(options)
  const npmBinDir = bin ? path.dirname(bin) : ''
  let dropped = null
  try {
    dropped = removePowerShellShim(bin, options)
  } catch (error) {
    writes(`codeforge: could not drop the PowerShell shim (${error instanceof Error ? error.message : String(error)})\n`)
  }
  let shim = null
  try {
    shim = ensureUserShim(bin, options)
  } catch (error) {
    writes(`codeforge: could not install user command (${error instanceof Error ? error.message : String(error)})\n`)
  }
  try {
    ensurePrivateNodeShims(options)
  } catch (error) {
    writes(`codeforge: could not install node/npm commands (${error instanceof Error ? error.message : String(error)})\n`)
  }
  const localDir = shim ? path.dirname(shim) : userLocalBin(options.home, options)
  try {
    const persisted = persistUserPath(localDir, options)
    if (persisted.added) writes('codeforge: added to user PATH (new terminals will see it)\n')
  } catch (error) {
    writes(`codeforge: could not update user PATH (${error instanceof Error ? error.message : String(error)})\n`)
  }
  let live = null
  try {
    live = ensureLivePathLink(bin, 'codeforge', options)
    if (live) {
      writes(`codeforge: on PATH -> ${live}\n`)
      const nodeBin = path.join(codeforgeHome(options), 'node', 'bin')
      const exists = options.exists || ((file) => fs.existsSync(file))
      if (exists(path.join(nodeBin, 'node'))) {
        ensureLivePathLink(path.join(nodeBin, 'node'), 'node', options)
        ensureLivePathLink(path.join(nodeBin, 'npm'), 'npm', options)
        ensureLivePathLink(path.join(nodeBin, 'npm'), 'nmp', options)
        if (exists(path.join(nodeBin, 'npx'))) {
          ensureLivePathLink(path.join(nodeBin, 'npx'), 'npx', options)
        }
      }
    }
  } catch (error) {
    writes(`codeforge: could not link onto PATH (${error instanceof Error ? error.message : String(error)})\n`)
  }
  const hint = live ? '' : pathHint(npmBinDir, localDir, options.pathEnv, options)
  if (bin) writes(`codeforge: command -> ${shim || bin}\n`)
  if (dropped?.removed) {
    writes("codeforge: dropped npm's codeforge.ps1 (script policy blocks it; codeforge.cmd is used)\n")
  } else if (dropped) {
    writes(`codeforge: could not delete ${dropped.path}; PowerShell may refuse to run \`codeforge\`\n`)
    writes('codeforge: if it does, delete that file or run: Set-ExecutionPolicy RemoteSigned -Scope CurrentUser\n')
  }
  if (hint) {
    writes('codeforge: if `codeforge` is not found in this shell, run:\n')
    writes(`  ${hint}\n`)
  }
  return { bin, shim, hint, live }
}

module.exports = {
  ensureLivePathLink,
  ensurePrivateNodeShims,
  ensureUserShim,
  firstLiveBinDir,
  globalCodeForgeBin,
  installCliPath,
  pathContains,
  pathHint,
  persistUserPath,
  removePowerShellShim,
  userLocalBin,
}

if (require.main === module) {
  installCliPath()
}
