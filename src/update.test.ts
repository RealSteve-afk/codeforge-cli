import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  formatUpdateNotice,
  installNpmPackage,
  maybeLatestUpdate,
  npmGlobalPrefix,
  npmInstallCwd,
  npmInvocation,
  planUpdate,
  runUpdate,
} from './update'
import type { InstallSource } from './updateSources'

it('plans a CLI upgrade when npm latest is newer than this process', () => {
  expect(planUpdate('0.3.17', '0.3.18')).toEqual({ action: 'upgrade', from: '0.3.17', to: '0.3.18' })
  expect(planUpdate('0.3.18', '0.3.18')).toEqual({ action: 'pager', version: '0.3.18' })
  expect(planUpdate('0.3.18', null)).toEqual({ action: 'upgrade', from: '0.3.18', to: 'latest' })
})

it('formats a one-line update notice only when latest is newer', () => {
  expect(formatUpdateNotice('0.3.33', '0.3.34')).toBe(
    'codeforge: 0.3.33 → 0.3.34 available. Run codeforge update.\n',
  )
  expect(formatUpdateNotice('0.3.34', '0.3.34')).toBeNull()
})

it('returns the newer npm version from maybeLatestUpdate', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-update-check-'))
  try {
    const latest = await maybeLatestUpdate({
      current: '0.3.33',
      home,
      fetchLatest: async () => '0.3.34',
    })
    expect(latest).toBe('0.3.34')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('skips the update check when CODEFORGE_SKIP_UPDATE_CHECK=1', async () => {
  const previous = process.env.CODEFORGE_SKIP_UPDATE_CHECK
  process.env.CODEFORGE_SKIP_UPDATE_CHECK = '1'
  try {
    await expect(
      maybeLatestUpdate({ current: '0.3.33', fetchLatest: async () => '0.3.34' }),
    ).resolves.toBeNull()
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_SKIP_UPDATE_CHECK
    else process.env.CODEFORGE_SKIP_UPDATE_CHECK = previous
  }
})

it('resolves the npm --prefix from a unix global install layout', () => {
  expect(npmGlobalPrefix('/home/ada/.codeforge/lib/node_modules/@realsteve-afk/codeforge-cli')).toBe('/home/ada/.codeforge')
  expect(npmGlobalPrefix('/usr/local/lib/node_modules/@realsteve-afk/codeforge-cli')).toBe('/usr/local')
})

it('resolves the npm --prefix from a Windows global install layout', () => {
  const root = process.platform === 'win32' ? 'C:\\Users\\ada\\AppData\\Roaming\\npm' : path.join(os.tmpdir(), 'npm')
  const pkg = path.join(root, 'node_modules', '@realsteve-afk', 'codeforge-cli')
  expect(npmGlobalPrefix(pkg)).toBe(root)
})

it('picks CODEFORGE_HOME as the npm install cwd', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-update-cwd-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  try {
    expect(npmInstallCwd()).toBe(home)
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
  }
})

it('runs npm install with an explicit readable cwd, not the caller directory', () => {
  const spawn = jest.fn().mockReturnValue({ status: 0 })
  installNpmPackage('0.3.23', {
    npm: 'npm',
    prefix: '/tmp/prefix',
    spawn: spawn as never,
    cwd: '/tmp/safe-update',
  })
  expect(spawn).toHaveBeenCalledWith(
    'npm',
    ['install', '-g', '@realsteve-afk/codeforge-cli@0.3.23', '--prefix', '/tmp/prefix'],
    expect.objectContaining({ cwd: '/tmp/safe-update', stdio: 'inherit' }),
  )
})

it('surfaces the errno when npm cannot even be spawned', () => {
  const spawn = jest.fn().mockReturnValue({ status: null, error: { code: 'EINVAL' } })
  expect(() =>
    installNpmPackage('0.3.23', { npm: 'npm', prefix: '/tmp/p', spawn: spawn as never, cwd: '/tmp' }),
  ).toThrow(/spawn EINVAL/)
})




describe('npmInvocation on Windows', () => {
  const win = path.win32
  const dir = 'C:\\Users\\ada\\.codeforge\\node'
  const nodeExe = win.join(dir, 'node.exe')
  const cli = win.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')

  const existsFor = (present: string[]) => (file: string) => present.includes(file)

  it('runs node with npm-cli.js instead of the .cmd shim', () => {
    expect(
      npmInvocation(win.join(dir, 'npm.cmd'), ['install', '-g', 'x'], {
        platform: 'win32',
        exists: existsFor([nodeExe, cli]),
      }),
    ).toEqual({ file: nodeExe, args: [cli, 'install', '-g', 'x'] })
  })

  it('resolves a bare npm.cmd through PATH before following it', () => {
    const shim = win.join('C:\\Program Files\\nodejs', 'npm.cmd')
    const shimNode = win.join('C:\\Program Files\\nodejs', 'node.exe')
    const shimCli = win.join('C:\\Program Files\\nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    expect(
      npmInvocation('npm.cmd', ['install'], {
        platform: 'win32',
        pathEnv: ['C:\\Windows\\System32', 'C:\\Program Files\\nodejs'].join(';'),
        exists: existsFor([shim, shimNode, shimCli]),
      }),
    ).toEqual({ file: shimNode, args: [shimCli, 'install'] })
  })

  it('leaves a non-shim npm alone', () => {
    expect(npmInvocation('npm', ['install'], { platform: 'win32' })).toEqual({
      file: 'npm',
      args: ['install'],
    })
  })

  it('keeps the shim when its node/npm-cli.js cannot be found', () => {
    
    expect(
      npmInvocation(win.join(dir, 'npm.cmd'), ['install'], {
        platform: 'win32',
        exists: () => false,
      }),
    ).toEqual({ file: win.join(dir, 'npm.cmd'), args: ['install'] })
  })

  it('is a no-op off Windows', () => {
    expect(npmInvocation('npm', ['install'], { platform: 'darwin' })).toEqual({
      file: 'npm',
      args: ['install'],
    })
  })
})

describe('runUpdate sibling-install drift warnings', () => {
  const brewSource = {
    root: '/opt/homebrew/lib/node_modules/@realsteve-afk/codeforge-cli',
    prefix: '/opt/homebrew',
    version: '0.3.33',
  }

  function run(options: {
    latest?: string
    fetchError?: Error
    current?: string
    checkDrift?: (targetVersion: string) => InstallSource[]
  }) {
    const out: string[] = []
    const err: string[] = []
    const codePromise = runUpdate({
      currentVersion: options.current || '0.3.33',
      fetchLatest: options.fetchError
        ? async () => { throw options.fetchError }
        : async () => options.latest || '0.3.33',
      installPackage: async () => undefined,
      installPager: async () => ({ ok: true, skipped: true }),
      write: (text) => out.push(text),
      writeErr: (text) => err.push(text),
      checkDrift: options.checkDrift,
    })
    return { codePromise, out, err }
  }

  it('warns about an out-of-sync sibling after a successful upgrade', async () => {
    const checkDrift = jest.fn((_: string) => [brewSource])
    const { codePromise, err } = run({ latest: '0.3.35', checkDrift })
    expect(await codePromise).toBe(0)
    expect(checkDrift).toHaveBeenCalledWith('0.3.35')
    expect(err.join('')).toContain('codeforge: warning — another codeforge install is out of sync:')
    expect(err.join('')).toContain('/opt/homebrew/lib/node_modules/@realsteve-afk/codeforge-cli (0.3.33)')
    expect(err.join('')).toContain('npm i -g @realsteve-afk/codeforge-cli@0.3.35 --prefix /opt/homebrew')
  })

  it('warns on the no-op path too, against the running version', async () => {
    const checkDrift = jest.fn((_: string) => [brewSource])
    const { codePromise, err } = run({ latest: '0.3.35', current: '0.3.35', checkDrift })
    expect(await codePromise).toBe(0)
    expect(checkDrift).toHaveBeenCalledWith('0.3.35')
    expect(err.join('')).toContain('npm i -g @realsteve-afk/codeforge-cli@0.3.35 --prefix /opt/homebrew')
  })

  it('stays silent when every source matches the target version', async () => {
    const checkDrift = jest.fn((_: string) => [
      { root: brewSource.root, prefix: brewSource.prefix, version: '0.3.35' },
    ])
    const { codePromise, err } = run({ latest: '0.3.35', checkDrift })
    expect(await codePromise).toBe(0)
    expect(err.join('')).not.toContain('out of sync')
  })

  it('stays silent when there is nothing to check (single source)', async () => {
    const checkDrift = jest.fn((_: string) => [])
    const { codePromise, err } = run({ latest: '0.3.35', checkDrift })
    expect(await codePromise).toBe(0)
    expect(err.join('')).toBe('')
  })

  it('skips the check when the target is @latest (unknown installed version)', async () => {
    const checkDrift = jest.fn((_: string) => [brewSource])
    const { codePromise, err } = run({ fetchError: new Error('offline'), checkDrift })
    expect(await codePromise).toBe(0)
    expect(checkDrift).not.toHaveBeenCalled()
    expect(err.join('')).toBe('')
  })
})
