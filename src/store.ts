import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

export const DEFAULT_API_BASE = 'https://www.codeforge.dev'

export interface AuthRecord {
  token: string
  email: string
  user_id: string
  api_base: string
  plan_code?: string
  name?: string
}

export interface SessionRecord {
  last_conversation_id?: string
  last_project_id?: string
  last_model?: string
}

export function getCodeForgeHome(): string {
  const override = (process.env.CODEFORGE_HOME || '').trim()
  return override || path.join(os.homedir(), '.codeforge')
}

export function codeforgeEngineHome(): string {
  return path.join(getCodeForgeHome(), 'engine')
}

export function codeforgeAuthPath(): string {
  return path.join(getCodeForgeHome(), 'auth.json')
}

function authPath(): string {
  return codeforgeAuthPath()
}

function workspacePath(): string {
  return path.join(getCodeForgeHome(), 'workspace-paths.json')
}

function sessionPath(): string {
  return path.join(getCodeForgeHome(), 'session.json')
}

const HOME_MODE = 0o700
const FILE_MODE = 0o600

function ensureCodeForgeHome(): string {
  const home = getCodeForgeHome()
  fs.mkdirSync(home, { recursive: true, mode: HOME_MODE })
  try {
    fs.chmodSync(home, HOME_MODE)
  } catch {
    
  }
  return home
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  ensureCodeForgeHome()
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
    mode: FILE_MODE,
  })
  try {
    fs.chmodSync(file, FILE_MODE)
  } catch {
    
  }
}

export function readAuth(): AuthRecord | null {
  const raw = readJson<Partial<AuthRecord> | null>(authPath(), null)
  if (!raw || typeof raw.token !== 'string' || !raw.token.trim()) return null
  return {
    token: raw.token,
    email: String(raw.email || ''),
    user_id: String(raw.user_id || ''),
    api_base: String(raw.api_base || DEFAULT_API_BASE).replace(/\/+$/, ''),
    plan_code: String(raw.plan_code || ''),
    name: String(raw.name || ''),
  }
}

export function writeAuth(record: AuthRecord): void {
  const previous = readAuth()
  writeJson(authPath(), {
    token: record.token,
    email: record.email,
    user_id: record.user_id,
    api_base: record.api_base.replace(/\/+$/, '') || DEFAULT_API_BASE,
    plan_code: record.plan_code || '',
    name: record.name || '',
  })
  if (previous && previous.user_id !== record.user_id) {
    const session = readSession()
    if (session.last_conversation_id) {
      writeSession({ ...session, last_conversation_id: undefined })
    }
  }
}

export function readSession(): SessionRecord {
  return readJson<SessionRecord>(sessionPath(), {})
}

export function writeSession(record: SessionRecord): void {
  writeJson(sessionPath(), record)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function ensureConversationId(): string {
  const session = readSession()
  const current = String(session.last_conversation_id || '').trim()
  if (UUID_RE.test(current)) return current
  const id = randomUUID()
  writeSession({ ...session, last_conversation_id: id })
  return id
}

export function clearAuth(): void {
  try {
    fs.unlinkSync(authPath())
  } catch {
    
  }
}

export function readWorkspaces(): Record<string, string> {
  const raw = readJson<Record<string, string>>(workspacePath(), {})
  if (!raw || typeof raw !== 'object') return {}
  const kept: Record<string, string> = {}
  let dirty = false
  for (const [id, dir] of Object.entries(raw)) {
    if (typeof dir === 'string' && dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      kept[id] = dir
    } else {
      dirty = true
    }
  }
  if (dirty) writeJson(workspacePath(), kept)
  return kept
}

export function bindWorkspace(projectId: string, requestedPath: string): { projectId: string; path: string } {
  if (!projectId.trim()) throw new Error('missing project id')
  const trimmed = (requestedPath || '').trim()
  if (!trimmed) throw new Error('missing path')
  if (!fs.existsSync(trimmed)) throw new Error('directory does not exist')
  const stat = fs.statSync(trimmed)
  if (!stat.isDirectory()) throw new Error('path is not a directory')
  fs.accessSync(trimmed, fs.constants.R_OK)
  const resolved = fs.realpathSync.native(trimmed)
  const map = readWorkspaces()
  map[projectId] = resolved
  writeJson(workspacePath(), map)
  return { projectId, path: resolved }
}

export function requireAuth(): AuthRecord {
  const auth = readAuth()
  if (!auth) throw new Error('not logged in — run codeforge login')
  return auth
}

export function describeStatus(): {
  home: string
  logged_in: boolean
  email: string
  name: string
  plan_code: string
  api_base: string
  workspaces: Record<string, string>
  model: string
} {
  const auth = readAuth()
  return {
    home: getCodeForgeHome(),
    logged_in: Boolean(auth),
    email: auth?.email || '',
    name: auth?.name || '',
    plan_code: auth?.plan_code || '',
    api_base: auth?.api_base || process.env.CODEFORGE_API_BASE || DEFAULT_API_BASE,
    workspaces: readWorkspaces(),
    model: readSession().last_model || '',
  }
}
