import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'

const {
  NPM_PAGER_PLATFORMS,
  decodePayload,
  installPager,
  pagerNpmName,
  pagerPackageManifest,
  pagerTarballUrl,
  pagerUnavailableReason,
  platformKey,
  writeBinary,
} = require('./install-pager.js') as {
  NPM_PAGER_PLATFORMS: string[]
  decodePayload: (buf: Buffer) => Buffer
  installPager: (options?: Record<string, unknown>) => Promise<{
    ok: boolean
    dest?: string
    skipped?: boolean
    reason?: string
    url?: string
    packageDir?: string
  }>
  pagerNpmName: (key: string) => string
  pagerPackageManifest: (key: string, version: string) => { os: string[]; cpu: string[]; name: string }
  pagerTarballUrl: (key: string, version: string, options?: { registry?: string }) => string
  pagerUnavailableReason: (key: string, version?: string) => string
  platformKey: (env?: NodeJS.ProcessEnv, nodeArch?: string, nodePlatform?: string) => string
  writeBinary: (bytes: Buffer, dest: string) => void
}

it('ships npm platform packages for mac (arm + Intel), linux, and win32-x64', () => {
  expect([...NPM_PAGER_PLATFORMS].sort()).toEqual(
    ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'].sort(),
  )
  const win = pagerPackageManifest('win32-x64', '0.3.33')
  expect(win).toEqual(
    expect.objectContaining({
      name: '@realsteve-afk/codeforge-pager-win32-x64',
      os: ['win32'],
      cpu: ['x64'],
    }),
  )
  expect(pagerNpmName('darwin-arm64')).toBe('@realsteve-afk/codeforge-pager-darwin-arm64')
  expect(pagerTarballUrl('win32-x64', '0.3.33', { registry: 'https://registry.npmmirror.com' })).toBe(
    'https://registry.npmmirror.com/@realsteve-afk%2fcodeforge-pager-win32-x64/-/codeforge-pager-win32-x64-0.3.33.tgz',
  )
})

it('selects win32-x64 on 64-bit Windows even when Node is ia32', () => {
  expect(
    platformKey({ PROCESSOR_ARCHITECTURE: 'x86', PROCESSOR_ARCHITEW6432: 'AMD64' }, 'ia32', 'win32'),
  ).toBe('win32-x64')
  expect(platformKey({ PROCESSOR_ARCHITECTURE: 'AMD64' }, 'x64', 'win32')).toBe('win32-x64')
  expect(platformKey({ PROCESSOR_ARCHITECTURE: 'x86' }, 'ia32', 'win32')).toBe('win32-ia32')
  expect(platformKey({}, 'arm64', 'darwin')).toBe('darwin-arm64')
})

it('fails closed on unsupported platforms instead of Node TUI', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
  expect(pagerUnavailableReason('freebsd-x64', pkg.version)).not.toMatch(/Node TUI/)
  expect(pagerUnavailableReason('win32-ia32', pkg.version)).toContain('win32-ia32')
  const result = await installPager({ platform: 'freebsd-x64', version: pkg.version })
  expect(result.ok).toBe(false)
  expect(result.skipped).toBe(false)
  expect(result.reason).toBe(pagerUnavailableReason('freebsd-x64', pkg.version))
})

it('installs from an npm platform package directory without GitHub', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-pager-npm-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  const pkgDir = path.join(home, 'pkg')
  fs.mkdirSync(pkgDir)
  const raw = Buffer.from('npm-pager-bytes')
  fs.writeFileSync(path.join(pkgDir, 'codeforge-pager-win32-x64.br'), zlib.brotliCompressSync(raw))
  try {
    const result = await installPager({
      platform: 'win32-x64',
      version: '0.3.33',
      dest: path.join(home, 'bin', 'codeforge-pager.exe'),
      packageDir: pkgDir,
      force: true,
    })
    expect(result.ok).toBe(true)
    expect(result.packageDir).toBe(pkgDir)
    expect(fs.readFileSync(String(result.dest)).equals(raw)).toBe(true)
    expect(fs.readFileSync(`${result.dest}.version`, 'utf8').trim()).toBe('0.3.33')
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('decodes a brotli pager payload like @forge-official/forge', () => {
  const raw = Buffer.from('codeforge-forge-pager-fixture')
  const br = zlib.brotliCompressSync(raw)
  expect(decodePayload(br).equals(raw)).toBe(true)
  expect(decodePayload(raw).equals(raw)).toBe(true)
})

it('replaces a stale pager when the package version changes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-pager-upgrade-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  const dest = path.join(home, 'bin', 'codeforge-pager')
  const oldFile = path.join(home, 'old.br')
  const nextFile = path.join(home, 'next.br')
  const oldRaw = Buffer.from('old-pager')
  const nextRaw = Buffer.from('codeforge-0.2.2-pager')
  fs.writeFileSync(oldFile, zlib.brotliCompressSync(oldRaw))
  fs.writeFileSync(nextFile, zlib.brotliCompressSync(nextRaw))
  try {
    await installPager({ file: oldFile, dest, platform: 'darwin-arm64', version: '0.2.1', force: true })
    expect(fs.readFileSync(dest).equals(oldRaw)).toBe(true)
    const skipped = await installPager({ file: nextFile, dest, platform: 'darwin-arm64', version: '0.2.1' })
    expect(skipped.skipped).toBe(true)
    expect(fs.readFileSync(dest).equals(oldRaw)).toBe(true)
    const forced = await installPager({
      file: nextFile,
      dest,
      platform: 'darwin-arm64',
      version: '0.2.1',
      force: true,
    })
    expect(forced.ok).toBe(true)
    expect(forced.skipped).toBeUndefined()
    expect(fs.readFileSync(dest).equals(nextRaw)).toBe(true)
    const upgraded = await installPager({ file: nextFile, dest, platform: 'darwin-arm64', version: '0.2.2' })
    expect(upgraded.ok).toBe(true)
    expect(upgraded.skipped).toBeUndefined()
    expect(fs.readFileSync(dest).equals(nextRaw)).toBe(true)
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('installs a win32-x64 pager payload as codeforge-pager.exe', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-pager-win32-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  const payload = path.join(home, 'codeforge-pager-win32-x64.br')
  const raw = Buffer.from('MZ-codeforge-win32-pager')
  fs.writeFileSync(payload, zlib.brotliCompressSync(raw))
  try {
    const result = await installPager({
      file: payload,
      dest: path.join(home, 'bin', 'codeforge-pager.exe'),
      platform: 'win32-x64',
      version: '0.3.22',
      force: true,
    })
    expect(result.ok).toBe(true)
    expect(String(result.dest)).toMatch(/codeforge-pager\.exe$/)
    expect(fs.readFileSync(String(result.dest)).equals(raw)).toBe(true)
    expect(fs.readFileSync(`${result.dest}.version`, 'utf8').trim()).toBe('0.3.22')
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('installs from a local .br into ~/.codeforge/bin', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-pager-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  const payload = path.join(home, 'codeforge-pager-darwin-arm64.br')
  const raw = Buffer.from('#!/bin/sh\necho forge-pager\n')
  fs.writeFileSync(payload, zlib.brotliCompressSync(raw))
  try {
    const result = await installPager({
      file: payload,
      dest: path.join(home, 'bin', 'codeforge-pager'),
      platform: 'darwin-arm64',
      force: true,
    })
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(String(result.dest)).equals(raw)).toBe(true)
    const dest = path.join(home, 'bin', 'copy')
    writeBinary(raw, dest)
    expect(fs.readFileSync(dest).equals(raw)).toBe(true)
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})
