import fs from 'fs'
import os from 'os'
import path from 'path'

const {
  ensurePrivateNodeShims,
  ensureUserShim,
  firstLiveBinDir,
  globalCodeForgeBin,
  installCliPath,
  pathContains,
  pathHint,
} = require('./ensure-cli-path.js') as {
  ensurePrivateNodeShims: (options?: Record<string, unknown>) => string[]
  ensureUserShim: (target: string, options?: Record<string, unknown>) => string | null
  firstLiveBinDir: (pathEnv?: string, options?: Record<string, unknown>) => string
  globalCodeForgeBin: (options?: Record<string, unknown>) => string
  installCliPath: (options?: Record<string, unknown>) => {
    bin: string
    shim: string | null
    hint: string
    live?: string | null
  }
  pathContains: (dir: string, pathEnv?: string) => boolean
  pathHint: (
    npmBin: string,
    localBin: string,
    pathEnv?: string,
    options?: Record<string, unknown>,
  ) => string
}

it('resolves the global codeforge from npm_config_prefix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-prefix-'))
  const bin = path.join(root, 'bin', 'codeforge')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '#!/usr/bin/env node\n')
  try {
    expect(globalCodeForgeBin({ prefix: root, platform: 'linux', exists: (file: string) => file === bin })).toBe(bin)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('links private npm and the nmp typo into ~/.local/bin next to codeforge', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-npm-shim-'))
  const nodeBin = path.join(home, '.codeforge', 'node', 'bin')
  fs.mkdirSync(nodeBin, { recursive: true })
  fs.writeFileSync(path.join(nodeBin, 'node'), '#!/bin/sh\n')
  fs.writeFileSync(path.join(nodeBin, 'npm'), '#!/bin/sh\n')
  fs.writeFileSync(path.join(nodeBin, 'npx'), '#!/bin/sh\n')
  try {
    const shims = ensurePrivateNodeShims({ home, platform: 'linux' })
    const local = path.join(home, '.local', 'bin')
    expect(shims).toEqual(expect.arrayContaining([
      path.join(local, 'node'),
      path.join(local, 'npm'),
      path.join(local, 'nmp'),
      path.join(local, 'npx'),
    ]))
    expect(fs.realpathSync(path.join(local, 'nmp'))).toBe(fs.realpathSync(path.join(nodeBin, 'npm')))
    expect(fs.realpathSync(path.join(local, 'npm'))).toBe(fs.realpathSync(path.join(nodeBin, 'npm')))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('links codeforge into ~/.local/bin so Debian login PATH can see it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-home-'))
  const target = path.join(home, 'npm', 'bin', 'codeforge')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, '#!/usr/bin/env node\n')
  try {
    const shim = ensureUserShim(target, { home, platform: 'linux' })
    expect(shim).toBe(path.join(home, '.local', 'bin', 'codeforge'))
    expect(fs.lstatSync(shim as string).isSymbolicLink()).toBe(true)
    expect(fs.realpathSync(shim as string)).toBe(fs.realpathSync(target))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('prints a PATH export when neither npm bin nor ~/.local/bin is on PATH', () => {
  expect(pathContains('/opt/bin', '/usr/bin:/bin')).toBe(false)
  expect(pathContains('/usr/bin', '/usr/bin:/bin')).toBe(true)
  const hint = pathHint('/opt/npm/bin', '/home/hanna/.local/bin', '/usr/bin:/bin')
  expect(hint).toContain('/home/hanna/.local/bin')
  expect(hint).toContain('/opt/npm/bin')
  expect(hint).toMatch(/^export PATH=/)
  expect(pathHint('/usr/bin', '/usr/bin', '/usr/bin:/bin')).toBe('')
})

it('keeps the npm bin link when the live PATH dir is the npm bin dir', () => {
  
  
  
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-brew-home-'))
  const prefix = path.join(home, 'homebrew')
  const pkgMain = path.join(prefix, 'lib', 'node_modules', '@realsteve-afk', 'codeforge-cli', 'dist', 'main.js')
  fs.mkdirSync(path.dirname(pkgMain), { recursive: true })
  fs.writeFileSync(pkgMain, '#!/usr/bin/env node\n')
  const bin = path.join(prefix, 'bin', 'codeforge')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.symlinkSync(path.relative(path.dirname(bin), pkgMain), bin)
  try {
    const result = installCliPath({
      prefix,
      home,
      platform: 'darwin',
      pathEnv: `${prefix}/bin:/usr/bin:/bin`,
      write: () => undefined,
    })
    expect(result.live).toBe(bin)
    expect(fs.realpathSync(bin)).toBe(fs.realpathSync(pkgMain))
    expect(path.resolve(path.dirname(bin), fs.readlinkSync(bin))).not.toBe(bin)
    const shim = path.join(home, '.local', 'bin', 'codeforge')
    expect(fs.realpathSync(shim)).toBe(fs.realpathSync(pkgMain))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('leaves a correct live link in place on a repeated install', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-reinstall-home-'))
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-reinstall-bin-'))
  const prefix = path.join(home, 'npm')
  const bin = path.join(prefix, 'bin', 'codeforge')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '#!/usr/bin/env node\n')
  const options = {
    prefix,
    home,
    platform: 'linux',
    pathEnv: `${live}:/usr/bin:/bin`,
    write: () => undefined,
  }
  try {
    installCliPath(options)
    const first = fs.readlinkSync(path.join(live, 'codeforge'))
    installCliPath(options)
    expect(fs.readlinkSync(path.join(live, 'codeforge'))).toBe(first)
    expect(fs.realpathSync(path.join(live, 'codeforge'))).toBe(fs.realpathSync(bin))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(live, { recursive: true, force: true })
  }
})

it('prefers Homebrew bin when it is already on PATH', () => {
  const dir = firstLiveBinDir('/usr/bin:/opt/homebrew/bin:/usr/local/bin', {
    platform: 'darwin',
    isDir: (value: string) => value === '/opt/homebrew/bin' || value === '/usr/local/bin',
    writable: (value: string) => value === '/opt/homebrew/bin' || value === '/usr/local/bin',
  })
  expect(dir).toBe('/opt/homebrew/bin')
})

it('links codeforge into a writable directory already on PATH', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-live-home-'))
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-live-bin-'))
  const prefix = path.join(home, 'npm')
  const bin = path.join(prefix, 'bin', 'codeforge')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '#!/usr/bin/env node\n')
  const lines: string[] = []
  try {
    const result = installCliPath({
      prefix,
      home,
      platform: 'linux',
      pathEnv: `${live}:/usr/bin:/bin`,
      write: (text: string) => lines.push(text),
    })
    expect(result.live).toBe(path.join(live, 'codeforge'))
    expect(fs.lstatSync(path.join(live, 'codeforge')).isSymbolicLink()).toBe(true)
    expect(lines.join('')).toMatch(/on PATH -> /)
    expect(lines.join('')).not.toMatch(/if `codeforge` is not found/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(live, { recursive: true, force: true })
  }
})

it('installCliPath writes the command location and PATH hint', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-path-'))
  const prefix = path.join(home, 'npm')
  const bin = path.join(prefix, 'bin', 'codeforge')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '#!/usr/bin/env node\n')
  const lines: string[] = []
  try {
    const result = installCliPath({
      prefix,
      home,
      platform: 'linux',
      pathEnv: '/usr/bin:/bin',
      write: (text: string) => lines.push(text),
    })
    expect(result.shim).toBe(path.join(home, '.local', 'bin', 'codeforge'))
    expect(lines.join('')).toMatch(/command -> .*\/.local\/bin\/codeforge/)
    expect(lines.join('')).toMatch(/if `codeforge` is not found/)
    expect(lines.join('')).toMatch(/export PATH=/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('resolves codeforge.cmd from the npm prefix root on Windows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-win-prefix-'))
  const bin = path.join(root, 'codeforge.cmd')
  fs.writeFileSync(bin, '@echo off\r\n')
  try {
    expect(globalCodeForgeBin({ prefix: root, platform: 'win32', exists: (file: string) => file === bin })).toBe(bin)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('finds codeforge.cmd from process.platform when install options omit platform', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-win-host-'))
  const bin = path.join(root, 'codeforge.cmd')
  fs.writeFileSync(bin, '@echo off\r\n')
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    expect(globalCodeForgeBin({ prefix: root, exists: (file: string) => file === bin })).toBe(bin)
  } finally {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('writes Windows wrappers into %LOCALAPPDATA%\\codeforge\\bin that call the original codeforge.cmd', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-win-home-'))
  const localAppData = path.join(home, 'AppData', 'Local')
  const target = path.join(home, 'AppData', 'Roaming', 'npm', 'codeforge.cmd')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, '@echo off\r\nnode main.js %*\r\n')
  try {
    const shim = ensureUserShim(target, { home, platform: 'win32', localAppData })
    expect(shim).toBe(path.join(localAppData, 'codeforge', 'bin', 'codeforge.cmd'))
    const body = fs.readFileSync(shim as string, 'utf8')
    expect(body).toContain(target)
    expect(body).toMatch(/%\*/)
    const sh = path.join(localAppData, 'codeforge', 'bin', 'codeforge')
    expect(fs.existsSync(sh)).toBe(true)
    expect(fs.readFileSync(sh, 'utf8')).toMatch(/^#!/)
    expect(fs.existsSync(path.join(localAppData, 'codeforge', 'bin', 'codeforge.ps1'))).toBe(false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('removes a codeforge.ps1 left behind by an older install', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-win-stale-'))
  const localAppData = path.join(home, 'AppData', 'Local')
  const binDir = path.join(localAppData, 'codeforge', 'bin')
  const target = path.join(home, 'AppData', 'Roaming', 'npm', 'codeforge.cmd')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(target, '@echo off\r\n')
  fs.writeFileSync(path.join(binDir, 'codeforge.ps1'), '& "codeforge.cmd" @args\r\n')
  try {
    ensureUserShim(target, { home, platform: 'win32', localAppData })
    expect(fs.existsSync(path.join(binDir, 'codeforge.ps1'))).toBe(false)
    expect(fs.existsSync(path.join(binDir, 'codeforge.cmd'))).toBe(true)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('reports a codeforge.ps1 it could not delete instead of claiming success', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-win-stuck-'))
  const localAppData = path.join(home, 'AppData', 'Local')
  const prefix = path.join(home, 'AppData', 'Roaming', 'npm')
  fs.mkdirSync(prefix, { recursive: true })
  fs.writeFileSync(path.join(prefix, 'codeforge.cmd'), '@echo off\r\n')
  
  fs.mkdirSync(path.join(prefix, 'codeforge.ps1'), { recursive: true })
  const lines: string[] = []
  let userPath = 'C:\\Windows\\system32'
  try {
    installCliPath({
      prefix,
      home,
      localAppData,
      platform: 'win32',
      pathEnv: 'C:\\Windows\\system32',
      readUserPath: () => userPath,
      writeUserPath: (value: string) => {
        userPath = value
      },
      write: (text: string) => lines.push(text),
    })
    expect(lines.join('')).not.toMatch(/dropped npm's codeforge\.ps1/)
    expect(lines.join('')).toContain('could not delete')
    expect(lines.join('')).toContain('Set-ExecutionPolicy RemoteSigned')
    
    expect(userPath.split(';')).toContain(path.join(localAppData, 'codeforge', 'bin'))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('prints cmd, PowerShell, and Git Bash PATH assignments on Windows', () => {
  const localBin = 'C:\\Users\\hanna\\AppData\\Local\\codeforge\\bin'
  const hint = pathHint('C:\\Users\\hanna\\AppData\\Roaming\\npm', localBin, 'C:\\Windows\\system32', {
    platform: 'win32',
  })
  expect(hint).toContain(localBin)
  expect(hint).toMatch(/set PATH=/)
  expect(hint).toContain('$env:Path')
  expect(hint).toMatch(/export PATH=/)
  expect(hint).toContain('/c/Users/hanna/AppData/Local/codeforge/bin')
})

it('installCliPath on Windows persists the shim directory on the user PATH once', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-win-path-'))
  const localAppData = path.join(home, 'AppData', 'Local')
  const prefix = path.join(home, 'AppData', 'Roaming', 'npm')
  const bin = path.join(prefix, 'codeforge.cmd')
  fs.mkdirSync(prefix, { recursive: true })
  fs.writeFileSync(bin, '@echo off\r\n')
  fs.writeFileSync(path.join(prefix, 'codeforge.ps1'), '& "codeforge.cmd" @args\r\n')
  const lines: string[] = []
  let userPath = 'C:\\Windows\\system32'
  try {
    const first = installCliPath({
      prefix,
      home,
      localAppData,
      platform: 'win32',
      pathEnv: 'C:\\Windows\\system32',
      readUserPath: () => userPath,
      writeUserPath: (value: string) => {
        userPath = value
      },
      write: (text: string) => lines.push(text),
    })
    const shimDir = path.join(localAppData, 'codeforge', 'bin')
    expect(first.shim).toBe(path.join(shimDir, 'codeforge.cmd'))
    expect(fs.existsSync(path.join(prefix, 'codeforge.ps1'))).toBe(false)
    expect(lines.join('')).toMatch(/dropped npm's codeforge\.ps1/)
    expect(userPath.split(';')).toContain(shimDir)
    expect(lines.join('')).toMatch(/set PATH=/)
    expect(lines.join('')).toContain('$env:Path')

    const second = installCliPath({
      prefix,
      home,
      localAppData,
      platform: 'win32',
      pathEnv: userPath,
      readUserPath: () => userPath,
      writeUserPath: (value: string) => {
        userPath = value
      },
      write: () => undefined,
    })
    expect(second.shim).toBe(path.join(shimDir, 'codeforge.cmd'))
    expect(userPath.split(';').filter((entry) => entry === shimDir)).toHaveLength(1)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
