import fs from 'fs'
import os from 'os'
import path from 'path'

import { getCodeForgeHome } from './store'
import { npmGlobalPrefix } from './update'

export type InstallSource = {
  
  root: string
  
  prefix: string
  version: string
}

export type FindSourcesOptions = {
  platform?: NodeJS.Platform
  home?: string
  env?: NodeJS.ProcessEnv
  
  pathEnv?: string
  
  packageRoot?: string
  exists?: (file: string) => boolean
  readFile?: (file: string) => string | null
  realpath?: (file: string) => string | null
}

const PKG_REL = path.join('@realsteve-afk', 'codeforge-cli')

function windowsNpmRoot(env: NodeJS.ProcessEnv): string {
  const appData =
    env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'npm', 'node_modules', ...PKG_REL.split(path.sep))
}

function defaultRealpath(file: string): string | null {
  try {
    return fs.realpathSync(file)
  } catch {
    return null
  }
}

function readVersion(
  root: string,
  readFile: (file: string) => string | null,
): string | null {
  try {
    const raw = readFile(path.join(root, 'package.json'))
    if (!raw) return null
    const version = (JSON.parse(raw) as { version?: unknown }).version
    return typeof version === 'string' && version ? version : null
  } catch {
    return null
  }
}


export function findInstallSources(options: FindSourcesOptions = {}): InstallSource[] {
  const platform = options.platform || process.platform
  const win = platform === 'win32'
  const home = options.home || getCodeForgeHome()
  const env = options.env || process.env
  const exists = options.exists || ((file: string) => fs.existsSync(file))
  const readFile =
    options.readFile ||
    ((file: string): string | null => {
      try {
        return fs.readFileSync(file, 'utf8')
      } catch {
        return null
      }
    })
  const realpath = options.realpath || defaultRealpath
  const pathSep = win ? ';' : ':'
  const pathEnv = options.pathEnv ?? env.PATH ?? env.Path ?? ''

  const candidates: string[] = []
  const ownPrefix = npmGlobalPrefix(options.packageRoot || path.join(__dirname, '..'))
  if (ownPrefix) {
    candidates.push(path.join(ownPrefix, 'lib', 'node_modules', ...PKG_REL.split(path.sep)))
    candidates.push(path.join(ownPrefix, 'node_modules', ...PKG_REL.split(path.sep)))
  }
  candidates.push(path.join(home, 'lib', 'node_modules', ...PKG_REL.split(path.sep)))
  if (win) {
    candidates.push(windowsNpmRoot(env))
  } else {
    candidates.push(path.join('/usr/local/lib/node_modules', ...PKG_REL.split(path.sep)))
  }

  
  
  
  const shimNames = win ? ['codeforge.cmd', 'codeforge.exe', 'codeforge'] : ['codeforge']
  const seenShimDir = new Set<string>()
  for (const dir of pathEnv.split(pathSep)) {
    if (!dir || seenShimDir.has(dir)) continue
    seenShimDir.add(dir)
    for (const name of shimNames) {
      const shim = win ? path.win32.join(dir, name) : path.join(dir, name)
      if (!exists(shim)) continue
      const target = realpath(shim) || shim
      const needle = path.join('node_modules', ...PKG_REL.split(path.sep))
      const idx = target.lastIndexOf(needle)
      if (idx >= 0) {
        candidates.push(target.slice(0, idx + needle.length))
      } else {
        candidates.push(
          path.join(path.dirname(target), '..', 'lib', 'node_modules', ...PKG_REL.split(path.sep)),
        )
      }
      break
    }
  }

  const sources: InstallSource[] = []
  const seen = new Set<string>()
  for (const root of candidates) {
    if (!root || !exists(path.join(root, 'package.json'))) continue
    const key = (realpath(root) || root).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const version = readVersion(root, readFile)
    if (!version) continue
    const prefix = npmGlobalPrefix(root)
    if (!prefix) continue
    sources.push({ root, prefix, version })
  }
  return sources
}


export function driftedSources(targetVersion: string, sources: InstallSource[]): InstallSource[] {
  return sources.filter((source) => source.version !== targetVersion)
}

export function formatDriftWarning(source: InstallSource, targetVersion: string): string {
  return (
    `codeforge: warning — another codeforge install is out of sync:\n` +
    `  ${source.root} (${source.version})\n` +
    `Run \`npm i -g @realsteve-afk/codeforge-cli@${targetVersion} --prefix ${source.prefix}\`, or uninstall it.\n`
  )
}
