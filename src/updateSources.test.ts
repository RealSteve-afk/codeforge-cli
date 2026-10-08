import path from 'path'

import {
  driftedSources,
  findInstallSources,
  formatDriftWarning,
  type FindSourcesOptions,
  type InstallSource,
} from './updateSources'


function fakeFs(files: Record<string, string>, symlinks: Record<string, string> = {}) {
  return {
    exists: (file: string) => file in files,
    readFile: (file: string) => files[file] ?? null,
    realpath: (file: string) => symlinks[file] ?? (file in files ? file : null),
  }
}

function pkgJson(version: string): string {
  return JSON.stringify({ name: '@realsteve-afk/codeforge-cli', version })
}

const HOME = '/home/ada/.codeforge'
const HOME_PKG = path.join(HOME, 'lib', 'node_modules', '@realsteve-afk', 'codeforge-cli')
const BREW_PKG = '/opt/homebrew/lib/node_modules/@realsteve-afk/codeforge-cli'
const USR_PKG = '/usr/local/lib/node_modules/@realsteve-afk/codeforge-cli'
const WIN_PKG = path.join('C:\\Users\\ada\\AppData\\Roaming', 'npm', 'node_modules', '@realsteve-afk', 'codeforge-cli')

function options(overrides: Partial<FindSourcesOptions> = {}): FindSourcesOptions {
  return {
    platform: 'darwin',
    home: HOME,
    env: {},
    pathEnv: '',
    packageRoot: path.join(HOME_PKG, 'dist'),
    ...overrides,
  }
}

it('finds the private ~/.codeforge install and reports its prefix', () => {
  const files = { [path.join(HOME_PKG, 'package.json')]: pkgJson('0.3.35') }
  const sources = findInstallSources({ ...options(), ...fakeFs(files) })
  expect(sources).toEqual([{ root: HOME_PKG, prefix: HOME, version: '0.3.35' }])
})

it('finds a Homebrew sibling via a PATH shim symlink', () => {
  const files = {
    [path.join(HOME_PKG, 'package.json')]: pkgJson('0.3.35'),
    [path.join(BREW_PKG, 'package.json')]: pkgJson('0.3.33'),
    '/opt/homebrew/bin/codeforge': 'shim',
  }
  const symlinks = {
    '/opt/homebrew/bin/codeforge': path.join(BREW_PKG, 'dist', 'main.js'),
  }
  const sources = findInstallSources({
    ...options({ pathEnv: '/opt/homebrew/bin:/usr/bin' }),
    ...fakeFs(files, symlinks),
  })
  expect(sources).toContainEqual({ root: BREW_PKG, prefix: '/opt/homebrew', version: '0.3.33' })
  expect(sources).toContainEqual({ root: HOME_PKG, prefix: HOME, version: '0.3.35' })
})

it('resolves a shim whose target is not inside the package (sibling lib layout)', () => {
  const shim = '/usr/local/bin/codeforge'
  const files = {
    [path.join(USR_PKG, 'package.json')]: pkgJson('0.3.32'),
    [shim]: 'shim',
  }
  const sources = findInstallSources({
    ...options({ pathEnv: '/usr/local/bin' }),
    ...fakeFs(files, { [shim]: '/usr/local/bin/codeforge-real' }),
  })
  expect(sources).toContainEqual({ root: USR_PKG, prefix: '/usr/local', version: '0.3.32' })
})

it('checks /usr/local/lib even when its bin is not on PATH', () => {
  const files = { [path.join(USR_PKG, 'package.json')]: pkgJson('0.3.30') }
  const sources = findInstallSources({ ...options(), ...fakeFs(files) })
  expect(sources).toEqual([{ root: USR_PKG, prefix: '/usr/local', version: '0.3.30' }])
})

it('checks the Windows %AppData%\\npm global location from APPDATA', () => {
  
  
  
  const appData = '/win/home/ada/AppData/Roaming'
  const winPkg = path.join(appData, 'npm', 'node_modules', '@realsteve-afk', 'codeforge-cli')
  const files = { [path.join(winPkg, 'package.json')]: pkgJson('0.3.31') }
  const sources = findInstallSources({
    ...options({ platform: 'win32', env: { APPDATA: appData } }),
    ...fakeFs(files),
  })
  expect(sources).toEqual([
    { root: winPkg, prefix: path.join(appData, 'npm'), version: '0.3.31' },
  ])
})

it('skips missing installs and dedupes the same root reached twice', () => {
  const files = {
    [path.join(HOME_PKG, 'package.json')]: pkgJson('0.3.35'),
    [path.join(BREW_PKG, 'package.json')]: pkgJson('0.3.35'),
    '/opt/homebrew/bin/codeforge': 'shim',
  }
  const sources = findInstallSources({
    ...options({ pathEnv: '/opt/homebrew/bin' }),
    ...fakeFs(files, { '/opt/homebrew/bin/codeforge': path.join(BREW_PKG, 'dist', 'main.js') }),
  })
  expect(sources).toHaveLength(2)
})

it('ignores candidates without a readable version', () => {
  const files = { [path.join(HOME_PKG, 'package.json')]: '{not json' }
  expect(findInstallSources({ ...options(), ...fakeFs(files) })).toEqual([])
})

it('flags only sources whose version differs from the update target', () => {
  const sources: InstallSource[] = [
    { root: HOME_PKG, prefix: HOME, version: '0.3.35' },
    { root: BREW_PKG, prefix: '/opt/homebrew', version: '0.3.33' },
  ]
  expect(driftedSources('0.3.35', sources)).toEqual([sources[1]])
  expect(driftedSources('0.3.34', sources)).toHaveLength(2)
  expect(driftedSources('0.3.35', sources)).toHaveLength(1)
})

it('formats a warning with the exact fix command and prefix', () => {
  const source: InstallSource = { root: BREW_PKG, prefix: '/opt/homebrew', version: '0.3.33' }
  expect(formatDriftWarning(source, '0.3.35')).toBe(
    'codeforge: warning — another codeforge install is out of sync:\n' +
      '  /opt/homebrew/lib/node_modules/@realsteve-afk/codeforge-cli (0.3.33)\n' +
      'Run `npm i -g @realsteve-afk/codeforge-cli@0.3.35 --prefix /opt/homebrew`, or uninstall it.\n',
  )
})
