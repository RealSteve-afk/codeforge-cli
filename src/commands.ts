import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { defaultHttp, errorDetail, HttpClient, authHeaders } from './http'
import { CodeForgeClientKind } from './client'
import { createLaunchStubModel } from './runtime/loop'
import {
  fetchModelCatalog,
  resolveCatalogModel,
  resolveRuntimeModel,
  type CatalogModel,
} from './runtime/models'
import { execLocalTurn } from './runtime/transport'
import type { ModelClient } from './runtime/types'

export { fetchModelCatalog, resolveCatalogModel, resolveRuntimeModel }
export type { CatalogModel }
import {
  bindWorkspace,
  clearAuth,
  DEFAULT_API_BASE,
  describeStatus,
  readAuth,
  readSession,
  readWorkspaces,
  requireAuth,
  writeAuth,
  writeSession,
} from './store'
import { CODEFORGE_CLIENT_VERSION } from './client'
import { comparePagerStamp, installedPagerStamp } from './runtime/launch'


export function formatCliReleaseStatus(
  version = CODEFORGE_CLIENT_VERSION,
  pagerStamp = installedPagerStamp(),
): string {
  const lines = [`cli ${version}`, `pager ${pagerStamp || 'none'}`]
  if (!pagerStamp || comparePagerStamp(pagerStamp, version) < 0) {
    lines.push('pager behind — run codeforge update')
  }
  return lines.join('\n')
}

export interface LoginInput {
  email?: string
  password?: string
  token?: string
  apiBase?: string
}

export async function loginCommand(input: LoginInput, http: HttpClient = defaultHttp): Promise<string> {
  const apiBase = (input.apiBase || process.env.CODEFORGE_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '')
  if (input.token) {
    const me = await http(`${apiBase}/api/auth/me`, { headers: authHeaders(input.token) })
    const user = await me.json().catch(() => ({}))
    if (!me.ok) throw new Error(errorDetail(user, `login failed (${me.status})`))
    writeAuth({
      token: input.token,
      email: user.email || '',
      user_id: String(user.id || ''),
      api_base: apiBase,
      plan_code: user.plan_code || '',
      name: user.name || '',
    })
    return user.email || 'authenticated'
  }

  if (!input.email || !input.password) {
    throw new Error('login requires --email/--password, --token, or a web login')
  }
  const response = await http(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: input.email, password: input.password }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(errorDetail(body, `login failed (${response.status})`))
  }
  const token = String(body.access_token || '')
  if (!token) throw new Error('login response missing access_token')
  writeAuth({
    token,
    email: body.user?.email || input.email,
    user_id: String(body.user?.id || ''),
    api_base: apiBase,
    plan_code: body.user?.plan_code || '',
    name: body.user?.name || '',
  })
  return body.user?.email || input.email
}

export function logoutCommand(): void {
  clearAuth()
}

export interface WebLoginStart {
  verification_uri: string
  verification_uri_complete: string
  user_code: string
}

export interface WebLoginInput {
  apiBase?: string
  grantCode?: string
  openBrowser?: (url: string) => void
  sleep?: (ms: number) => Promise<void>
  onStart?: (info: WebLoginStart) => void
  maxAttempts?: number
}

export function resolveVerificationUrl(raw: string, apiBase: string): string {
  const base = new URL(apiBase.endsWith('/') ? apiBase : `${apiBase}/`)
  const parsed = new URL(raw, base)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('verification URL must be http(s)')
  }
  parsed.protocol = base.protocol
  parsed.host = base.host
  return parsed.toString()
}

export function openBrowserSafely(
  url: string,
  spawnFn: typeof spawn = spawn,
  platform: NodeJS.Platform = process.platform,
): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
  try {
    const child = platform === 'darwin'
      ? spawnFn('open', [parsed.toString()], { detached: true, stdio: 'ignore' })
      : platform === 'win32'
        
        
        ? spawnFn('cmd.exe', ['/c', 'start', '', parsed.toString()], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          })
        : spawnFn('xdg-open', [parsed.toString()], { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    
  }
}

function pendingPoll(status: number, body: { detail?: unknown }): boolean {
  if (status === 428) return true
  return String(body.detail || '') === 'authorization_pending'
}

export async function webLoginCommand(
  input: WebLoginInput = {},
  http: HttpClient = defaultHttp,
): Promise<string> {
  const apiBase = (input.apiBase || process.env.CODEFORGE_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '')
  if (input.grantCode) {
    const exchanged = await http(`${apiBase}/api/auth/cli/device/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_code: input.grantCode }),
    })
    const body = await exchanged.json().catch(() => ({}))
    if (!exchanged.ok) throw new Error(errorDetail(body, `grant exchange failed (${exchanged.status})`))
    const token = String(body.access_token || '')
    if (!token) throw new Error('grant exchange missing access_token')
    return loginCommand({ token, apiBase }, http)
  }

  const started = await http(`${apiBase}/api/auth/cli/device`, { method: 'POST' })
  const startBody = await started.json().catch(() => ({}))
  if (!started.ok) {
    if (started.status === 404 || started.status === 405) {
      throw new Error('Browser login is not on this server yet. Use: codeforge login --email <email> --password <password>')
    }
    if (started.status === 503) {
      throw new Error('Sign-in is temporarily unavailable. Try again in a moment.')
    }
    throw new Error(errorDetail(startBody, `device start failed (${started.status})`))
  }
  const deviceCode = String(startBody.device_code || '')
  const userCode = String(startBody.user_code || '')
  const rawVerify = String(startBody.verification_uri_complete || startBody.verification_uri || '')
  if (!deviceCode || !userCode || !rawVerify) throw new Error('device start missing fields')
  const complete = resolveVerificationUrl(rawVerify, apiBase)
  input.onStart?.({
    verification_uri: String(startBody.verification_uri || complete),
    verification_uri_complete: complete,
    user_code: userCode,
  })
  try {
    (input.openBrowser ?? openBrowserSafely)(complete)
  } catch {
  }

  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const intervalSec = Math.max(1, Number(startBody.interval || 1))
  const expiresIn = Math.max(intervalSec, Number(startBody.expires_in || 600))
  const maxAttempts = input.maxAttempts ?? Math.max(1, Math.ceil(expiresIn / intervalSec))
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const polled = await http(`${apiBase}/api/auth/cli/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    })
    const body = await polled.json().catch(() => ({}))
    if (polled.ok) {
      const token = String(body.access_token || '')
      if (!token) throw new Error('device token missing access_token')
      return loginCommand({ token, apiBase }, http)
    }
    if (pendingPoll(polled.status, body)) {
      await sleep(Number(startBody.interval || 1) * 1000)
      continue
    }
    if (String(body.detail || '') === 'access_denied') throw new Error('login cancelled')
    throw new Error(errorDetail(body, `device poll failed (${polled.status})`))
  }
  throw new Error('login timed out')
}

export function formatQuota(balance: {
  total?: number
  plan?: { plan_name?: string | null; plan_code?: string | null; balance?: number }
  wallet?: { balance?: number }
  bonus?: { balance?: number }
  allowance?: { unlimited?: boolean; limit?: number; used?: number }
}): string {
  if (balance.allowance?.unlimited) return 'quota unlimited'
  const total = Number(balance.total ?? 0)
  const plan = Number(balance.plan?.balance ?? 0)
  const wallet = Number(balance.wallet?.balance ?? 0)
  const bonus = Number(balance.bonus?.balance ?? 0)
  const name = balance.plan?.plan_name || balance.plan?.plan_code || 'plan'
  const allowance = balance.allowance
  const ration = allowance
    ? `allowance ${allowance.used ?? 0}/${allowance.limit ?? 0}`
    : ''
  return [`quota ${total} pts`, `${name} ${plan}`, `wallet ${wallet}`, `bonus ${bonus}`, ration].filter(Boolean).join(' · ')
}

export async function fetchBalance(http: HttpClient = defaultHttp): Promise<any> {
  const auth = requireAuth()
  const response = await http(`${auth.api_base}/api/points/balance`, { headers: authHeaders(auth.token) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(errorDetail(body, `balance failed (${response.status})`))
  return body
}

export async function statusCommand(http?: HttpClient): Promise<string> {
  const status = describeStatus()
  const lines = [
    ...formatCliReleaseStatus().split('\n'),
    `home ${status.home}`,
    status.logged_in ? `user ${status.email}${status.plan_code ? ` (${status.plan_code})` : ''}` : 'user logged out',
    `api  ${status.api_base}`,
  ]
  if (status.logged_in && http) {
    try {
      lines.push(formatQuota(await fetchBalance(http)))
    } catch (error) {
      lines.push(`quota unavailable (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  const entries = Object.entries(status.workspaces)
  if (!entries.length) {
    lines.push('workspaces none')
  } else {
    for (const [projectId, workspacePath] of entries) {
      lines.push(`workspace ${projectId} ${workspacePath}`)
    }
  }
  return lines.join('\n')
}

export function openCommand(projectId: string, dir: string): string {
  const resolved = dir === '.' ? process.cwd() : dir
  if (!fs.existsSync(resolved)) throw new Error('directory does not exist')
  const bound = bindWorkspace(projectId, resolved)
  const session = readSession()
  writeSession({ ...session, last_project_id: bound.projectId })
  return `opened ${bound.path} for ${bound.projectId}`
}

export function resolveBoundWorkspace(projectId?: string): { projectId: string; path: string } {
  const workspaces = readWorkspaces()
  const requested = (projectId || readSession().last_project_id || '').trim()
  if (requested && workspaces[requested]) {
    return { projectId: requested, path: workspaces[requested] }
  }
  const entries = Object.entries(workspaces)
  if (entries.length === 1) return { projectId: entries[0][0], path: entries[0][1] }
  if (!entries.length) throw new Error('no local workspace — run codeforge open <dir> --project <id>')
  throw new Error('multiple workspaces — pass --project')
}

function formatDirListing(bound: { projectId: string; path: string }): string {
  const names = fs.readdirSync(bound.path).filter((name) => !name.startsWith('.'))
  if (!names.length) return `${bound.path} (empty)`
  return names.map((name) => {
    const full = path.join(bound.path, name)
    const suffix = fs.statSync(full).isDirectory() ? '/' : ''
    return `${name}${suffix}`
  }).join('\n')
}

export function listLocalCommand(projectId?: string): string {
  requireAuth()
  const workspaces = readWorkspaces()
  const requested = (projectId || '').trim()
  if (requested) {
    if (!workspaces[requested]) throw new Error(`unknown workspace ${requested}`)
    return formatDirListing({ projectId: requested, path: workspaces[requested] })
  }
  const entries = Object.entries(workspaces)
  if (!entries.length) throw new Error('no local workspace — run codeforge open <dir> --project <id>')
  if (entries.length === 1) return formatDirListing({ projectId: entries[0][0], path: entries[0][1] })
  return entries.map(([id, dir]) => `${id}  ${dir}`).join('\n')
}

export async function execCommand(
  prompt: string,
  options: {
    projectId?: string
    conversationId?: string
    model?: string
    newConversation?: boolean
    client?: CodeForgeClientKind
    cwd?: string
    stub?: boolean
    modelClient?: ModelClient
  } = {},
  http: HttpClient = defaultHttp,
): Promise<{ conversationId: string; text: string }> {
  const text = prompt.trim()
  if (!text) throw new Error('prompt is required')
  const stub = Boolean(options.stub || process.env.CODEFORGE_RUNTIME_STUB === '1')
  const cwd = options.cwd || process.cwd()
  if (!stub) requireAuth()
  const modelClient = options.modelClient || (stub ? createLaunchStubModel() : undefined)
  if (options.projectId) {
    writeSession({ ...readSession(), last_project_id: options.projectId })
  }
  const model = await resolveRuntimeModel(http, { explicit: options.model, stub })
  const result = await execLocalTurn(text, {
    cwd,
    model,
    conversationId: options.conversationId,
    newConversation: options.newConversation,
    modelClient,
    http,
    client: options.client || 'cli',
  })
  return { conversationId: result.conversationId, text: result.text }
}

export async function listConversationsCommand(http: HttpClient = defaultHttp): Promise<string> {
  const auth = requireAuth()
  const response = await http(`${auth.api_base}/api/chat/conversations?source=cli&limit=30`, {
    headers: authHeaders(auth.token),
  })
  const body = await response.json().catch(() => [])
  if (!response.ok) throw new Error(errorDetail(body, `history failed (${response.status})`))
  const rows = Array.isArray(body) ? body : []
  if (!rows.length) return 'no saved conversations'
  return rows.map((row: { id?: string; title?: string; source?: string; client?: string }) => {
    const tag = row.source || row.client
    const suffix = tag ? ` [${tag}]` : ''
    return `${row.id}  ${row.title || '(untitled)'}${suffix}`
  }).join('\n')
}

export async function openConversationCommand(
  conversationId: string,
  http: HttpClient = defaultHttp,
): Promise<string> {
  const id = conversationId.trim()
  if (!id) throw new Error('conversation id is required')
  writeSession({ ...readSession(), last_conversation_id: id })
  const auth = requireAuth()
  const response = await http(`${auth.api_base}/api/chat/conversations/${id}`, {
    headers: authHeaders(auth.token),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(errorDetail(body, `thread failed (${response.status})`))
  const messages = Array.isArray(body.messages) ? body.messages : []
  const lines = [`opened ${id}`]
  if (body.title) lines.push(String(body.title))
  for (const msg of messages) {
    const role = String(msg?.role || '').trim()
    const content = String(msg?.content || '').trim()
    if (!role || !content) continue
    lines.push(`${role}: ${content}`)
  }
  if (lines.length === 1) lines.push('(no messages)')
  return lines.join('\n')
}

export async function setTrainingCommand(optIn: boolean, http: HttpClient = defaultHttp): Promise<string> {
  const auth = requireAuth()
  const response = await http(`${auth.api_base}/api/auth/profile`, {
    method: 'PATCH',
    headers: authHeaders(auth.token),
    body: JSON.stringify({ training_opt_in: optIn }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(errorDetail(body, `training update failed (${response.status})`))
  return optIn ? 'training opt-in on (new turns may be used if eligible)' : 'training opt-in off'
}

export async function listModelsCommand(http: HttpClient = defaultHttp): Promise<string> {
  const { models, defaultModel } = await fetchModelCatalog(http)
  const last = readSession().last_model || ''
  const current = models.some((row) => row.name === last) ? last : defaultModel
  if (!current && !models.length) return 'no models available'
  const lines = models.map((row) => {
    const mark = row.name === current ? '* ' : '  '
    const extra = row.label !== row.name ? `  ${row.label}` : ''
    return `${mark}${row.name}${extra}`
  })
  return lines.join('\n') || `* ${current}`
}

export async function setModelCommand(query: string, http: HttpClient = defaultHttp): Promise<string> {
  const wanted = query.trim()
  if (!wanted) return listModelsCommand(http)
  const name = await resolveRuntimeModel(http, { explicit: wanted })
  return `model ${name}`
}
