import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CODEFORGE_CLIENT_VERSION } from '../client'
import { DEFAULT_API_BASE, ensureConversationId, readAuth, getCodeForgeHome, codeforgeAuthPath, codeforgeEngineHome } from '../store'
import type { HttpClient } from '../http'
import { forgeBuildRoot } from './suite'
import { openaiCompatUrl } from './adapter'

const SCRATCH_DIRS = ['sessions', 'worktrees', 'hooks', 'logs'] as const

export class RuntimeUnavailable extends Error {
  constructor(message = 'CodeForge runtime is not available') {
    super(message)
    this.name = 'RuntimeUnavailable'
  }
}

export async function assertRuntimeAvailable(
  http: HttpClient,
  apiBase: string,
): Promise<void> {
  const url = `${apiBase.replace(/\/+$/, '')}/api/runtime/health`
  let response: { ok: boolean; status: number; json: () => Promise<unknown> }
  try {
    response = await http(url, { headers: { Accept: 'application/json' } })
  } catch (error) {
    throw new RuntimeUnavailable(error instanceof Error ? error.message : String(error))
  }
  if (!response || !response.ok) {
    throw new RuntimeUnavailable(`health ${response?.status ?? 'unreachable'}`)
  }
  const body = (await response.json().catch(() => null)) as { ok?: boolean } | null
  if (!body || body.ok !== true) throw new RuntimeUnavailable('health body missing ok')
}

export function pagerBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'codeforge-pager.exe' : 'codeforge-pager'
}

export function forgeBuildBinaryCandidates(): string[] {
  const env = (process.env.CODEFORGE_FORGE_BIN || '').trim()
  const root = forgeBuildRoot()
  const name = pagerBinaryName()
  const packaged = path.resolve(__dirname, '..', 'bin', name)
  const npmInstalled = path.join(getCodeForgeHome(), 'bin', name)
  return [
    env,
    npmInstalled,
    packaged,
    path.join(root, 'target', 'release', name),
    path.join(root, 'target', 'debug', name),
    path.join(root, 'target', 'release', 'codeforge-agent'),
  ].filter(Boolean)
}

export function findForgeBuildBinary(): string | null {
  for (const candidate of forgeBuildBinaryCandidates()) {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

export function codeforgeRuntimeApiBase(apiBase: string): string {
  return openaiCompatUrl(apiBase).replace(/\/chat\/completions$/, '')
}


export function purgeForgeEngineAuth(engine = codeforgeEngineHome()): string {
  const file = path.join(engine, 'auth.json')
  if (!fs.existsSync(file)) return file
  try {
    const raw = fs.readFileSync(file, 'utf8')
    if (!/auth\.forge\.dev|accounts\.forge\.dev|forge\.com/i.test(raw)) return file
    fs.writeFileSync(file, '{}\n', { encoding: 'utf8', mode: 0o600 })
  } catch {
  }
  return file
}

export function writeCodeForgeForgeConfig(): string {
  const auth = readAuth()
  const engine = codeforgeEngineHome()
  fs.mkdirSync(engine, { recursive: true, mode: 0o700 })
  purgeForgeEngineAuth(engine)
  const file = path.join(engine, 'config.toml')
  const runtimeBase = codeforgeRuntimeApiBase(auth?.api_base || process.env.CODEFORGE_API_BASE || DEFAULT_API_BASE)
  const body = [
    '# codeforge-managed forge-build config — CodeForge auth + models + quota',
    '[endpoints]',
    `forge_api_base_url = "${runtimeBase}"`,
    '',
    '[agent]',
    'system_prompt_label = "CodeForge"',
    '',
  ].join('\n')
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (!existing || existing.includes('codeforge-managed forge-build')) {
    fs.writeFileSync(file, `${body}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  return file
}

export function migrateForgeScratchToEngine(home: string): void {
  const engine = path.join(home, 'engine')
  fs.mkdirSync(engine, { recursive: true, mode: 0o700 })
  for (const name of SCRATCH_DIRS) {
    const from = path.join(home, name)
    const to = path.join(engine, name)
    if (!fs.existsSync(from)) continue
    if (fs.existsSync(to)) {
      for (const entry of fs.readdirSync(from)) {
        const src = path.join(from, entry)
        const dest = path.join(to, entry)
        if (!fs.existsSync(dest)) fs.renameSync(src, dest)
      }
      
      if (fs.readdirSync(from).length === 0) fs.rmdirSync(from)
    } else {
      fs.renameSync(from, to)
    }
  }
}

export function purgeChangelogCache(home: string, engine: string): void {
  for (const root of [home, engine]) {
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root)) {
      if (!entry.startsWith('CHANGELOG')) continue
      try {
        fs.unlinkSync(path.join(root, entry))
      } catch {
      }
    }
  }
}

export function installedPagerPath(): string {
  return path.join(getCodeForgeHome(), 'bin', pagerBinaryName())
}

export function pagerStampPath(dest = installedPagerPath()): string {
  return `${dest}.version`
}

export function installedPagerStamp(dest = installedPagerPath()): string {
  try {
    return fs.readFileSync(pagerStampPath(dest), 'utf8').trim()
  } catch {
    return ''
  }
}

export function comparePagerStamp(stamped: string, release: string): number {
  const parse = (value: string) => value.trim().split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(stamped)
  const right = parse(release)
  const n = Math.max(left.length, right.length)
  for (let i = 0; i < n; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

export function pagerStampMeetsRelease(
  stamped = installedPagerStamp(),
  release = CODEFORGE_CLIENT_VERSION,
): boolean {
  if (!stamped || !release) return false
  return comparePagerStamp(stamped, release) >= 0
}


export const MIN_PAGER_STAMP = '0.3.11'


export const AUTO_UPDATE_MIN_PAGER_STAMP = '0.3.38'


export function accessPointBfullEnabled(): boolean {
  return process.env.CODEFORGE_ACCESS_POINT_BFULL === '1' || pagerStampMeetsRelease(installedPagerStamp(), MIN_PAGER_STAMP)
}


export function pagerStampAllowsSpawn(binary: string): boolean {
  if (path.resolve(binary) !== path.resolve(installedPagerPath())) return true
  return pagerStampMeetsRelease(installedPagerStamp(binary), MIN_PAGER_STAMP)
}

const PAGER_LOADER_FAIL =
  /GLIBC_\d|not found \(required by|Exec format error|cannot execute binary file|error while loading shared libraries/i


export function firstReadableDir(candidates: Array<string | undefined | null>): string {
  for (const dir of candidates) {
    if (!dir) continue
    try {
      fs.accessSync(dir, fs.constants.R_OK)
      return dir
    } catch {
      continue
    }
  }
  return os.tmpdir()
}


export function pagerSpawnCwd(preferred = process.cwd(), home = getCodeForgeHome()): string {
  return firstReadableDir([preferred, home, os.homedir(), os.tmpdir()])
}


export function pagerProbeCwd(home = getCodeForgeHome()): string {
  return firstReadableDir([home, os.homedir(), os.tmpdir()])
}


export function pagerBinaryRunnable(
  binary: string,
  spawn: typeof spawnSync = spawnSync,
): boolean {
  if (!binary || !fs.existsSync(binary)) return false
  const result = spawn(binary, ['--help'], {
    encoding: 'utf8',
    timeout: 2500,
    env: { ...process.env, TERM: 'dumb' },
    cwd: pagerProbeCwd(),
  })
  const blob = `${result.stderr || ''}\n${result.stdout || ''}\n${result.error?.message || ''}`
  if (PAGER_LOADER_FAIL.test(blob)) return false
  const err = result.error as NodeJS.ErrnoException | undefined
  if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM')) return false
  if ((result.status ?? 0) === 127) return false
  return true
}


function envKeyOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase()
  return Object.keys(env).find((key) => key.toUpperCase() === upper)
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string {
  const key = envKeyOf(env, name)
  return (key && env[key]) || ''
}


function deleteEnv(env: NodeJS.ProcessEnv, name: string): void {
  const key = envKeyOf(env, name)
  if (key) delete env[key]
}


function setEnv(env: NodeJS.ProcessEnv, name: string, value: string): void {
  const upper = name.toUpperCase()
  const key = envKeyOf(env, name) || name
  for (const other of Object.keys(env)) {
    if (other !== key && other.toUpperCase() === upper) delete env[other]
  }
  env[key] = value
}

export function prependToolPath(pathEnv = process.env.PATH || '', home = getCodeForgeHome()): string {
  const extra =
    process.platform === 'win32'
      ? [path.join(home, 'node'), path.join(home, 'bin')]
      : [
          path.join(home, 'node', 'bin'),
          path.join(home, 'bin'),
          path.join(os.homedir(), '.local', 'bin'),
          '/opt/homebrew/bin',
        ]
  const delim = path.delimiter
  const current = pathEnv.split(delim).filter(Boolean)
  const seen = new Set(current.map((dir) => (process.platform === 'win32' ? dir.toLowerCase() : dir)))
  const prefix: string[] = []
  for (const dir of extra) {
    if (!dir || !fs.existsSync(dir)) continue
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(key)) continue
    seen.add(key)
    prefix.push(dir)
  }
  return [...prefix, ...current].join(delim)
}

export function codeforgeForgeBuildEnv(): NodeJS.ProcessEnv {
  const auth = readAuth()
  const engine = codeforgeEngineHome()
  const apiBase = auth?.api_base || process.env.CODEFORGE_API_BASE || DEFAULT_API_BASE
  const runtime = codeforgeRuntimeApiBase(apiBase)
  const env = { ...process.env }
  deleteEnv(env, 'CODEFORGE_HOME')
  deleteEnv(env, 'FORGE_CODE_FORGE_API_KEY')
  deleteEnv(env, 'FORGE_DEFAULT_MODEL')
  deleteEnv(env, 'CODEFORGE_TOKEN')
  
  
  
  deleteEnv(env, 'FORGE_DISABLE_API_KEY_AUTH')
  if (accessPointBfullEnabled()) {
    deleteEnv(env, 'FORGE_API_KEY')
    setEnv(env, 'CODEFORGE_TOKEN', auth?.token || '')
  } else {
    setEnv(env, 'FORGE_API_KEY', auth?.token || '')
  }
  
  
  
  deleteEnv(env, 'FORGE_AUTH')
  if (auth?.token) {
    setEnv(
      env,
      'FORGE_AUTH',
      JSON.stringify({
        key: auth.token,
        auth_mode: 'api_key',
        create_time: new Date().toISOString(),
        user_id: auth.user_id || 'codeforge',
        email: auth.email || undefined,
      }),
    )
  }
  purgeForgeEngineAuth(engine)
  setEnv(env, 'PATH', prependToolPath(readEnv(env, 'PATH'), getCodeForgeHome()))
  setEnv(env, 'CODEFORGE_ACCESS_POINT', '1')
  
  
  if (pagerStampMeetsRelease(installedPagerStamp(), AUTO_UPDATE_MIN_PAGER_STAMP)) {
    setEnv(env, 'CODEFORGE_AUTO_UPDATE', '1')
  }
  setEnv(env, 'FORGE_HOME', engine)
  setEnv(env, 'FORGE_AUTH_PATH', path.join(engine, 'auth.json'))
  setEnv(env, 'CODEFORGE_AUTH_PATH', codeforgeAuthPath())
  setEnv(env, 'CODEFORGE_ACCOUNT_EMAIL', auth?.email || '')
  setEnv(env, 'CODEFORGE_ACCOUNT_PLAN', auth?.plan_code || '')
  setEnv(env, 'CODEFORGE_API_BASE', apiBase)
  setEnv(env, 'CODEFORGE_CLIENT_VERSION', CODEFORGE_CLIENT_VERSION)
  setEnv(env, 'FORGE_SYSTEM_PROMPT_LABEL', 'CodeForge')
  setEnv(env, 'CODEFORGE_CONVERSATION_ID', ensureConversationId())
  setEnv(env, 'FORGE_FORGE_API_BASE_URL', runtime)
  setEnv(env, 'FORGE_API_BASE_URL', runtime)
  setEnv(env, 'FORGE_MODELS_BASE_URL', runtime)
  setEnv(env, 'FORGE_MODELS_LIST_URL', `${runtime}/models`)
  setEnv(env, 'FORGE_CLI_CHAT_PROXY_BASE_URL', runtime)
  setEnv(env, 'FORGE_DISABLE_CLI_CHAT_PROXY', '1')
  setEnv(env, 'FORGE_TELEMETRY_ENABLED', '0')
  setEnv(env, 'FORGE_CHANGELOG_OFFLINE', '1')
  return env
}

export function launchForgeBuildHeadless(prompt: string, cwd: string): { status: number; stdout: string; stderr: string; binary: string | null } {
  const binary = findForgeBuildBinary()
  if (!binary) {
    return { status: 127, stdout: '', stderr: 'forge-build binary not built', binary: null }
  }
  const result = spawnSync(binary, ['-p', prompt], {
    cwd,
    encoding: 'utf8',
    env: codeforgeForgeBuildEnv(),
    timeout: 30_000,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
    binary,
  }
}
