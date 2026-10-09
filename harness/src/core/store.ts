import fs from 'fs'
import os from 'os'
import path from 'path'
import { decryptSecret, encryptSecret, hashPassword, loadMasterKey, randomToken, sha256, verifyPassword } from './crypto'
import type { PlanItem } from './tools'
import type { SearchConfig, SearchProvider } from './web'

export type ProviderKind = 'anthropic' | 'openai'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type PermissionMode = 'ask' | 'auto'

export interface User {
  id: string
  username: string
  passwordHash: string
  isAdmin: boolean
  // Directories this user's sessions may use as a workspace. Admins may use any directory.
  workspaceRoots: string[]
  createdAt: string
}

export interface Profile {
  id: string
  userId: string
  name: string
  provider: ProviderKind
  model: string
  baseUrl?: string
  apiKeySealed?: string
  apiKeyHint?: string
  effort?: Effort
  thinking: boolean
  fallbacks: boolean
  createdAt: string
}

export type TranscriptItem =
  | { kind: 'user'; text: string; at: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; output: string; isError: boolean }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'progress'; text: string }
  | { kind: 'web'; id: string; action: 'search' | 'fetch'; query?: string; url?: string; results?: WebHit[]; title?: string; error?: string }
  | { kind: 'plan'; items: PlanItem[] }
  | { kind: 'question'; id: string; question: string; options: string[]; answer?: string }
  | { kind: 'summary'; seconds: number; steps: number; stopReason: string; inputTokens: number; outputTokens: number }

export interface WebHit {
  title: string
  url: string
}

export interface PublicSettings {
  search: { provider: SearchProvider; baseUrl?: string; hasKey: boolean }
}

interface StoredSettings {
  search: { provider: SearchProvider; baseUrl?: string; apiKeySealed?: string }
}

export interface Session {
  id: string
  userId: string
  profileId: string
  provider: ProviderKind
  model: string
  title: string
  workspace: string
  mode: PermissionMode
  // Whether the agent may search and read the web. Missing on older sessions means on.
  web?: boolean
  // Provider-native message history, append-only (see agent.ts).
  history: unknown[]
  transcript: TranscriptItem[]
  usage: { inputTokens: number; outputTokens: number }
  createdAt: string
  updatedAt: string
}

export type PublicUser = Omit<User, 'passwordHash'>
export type PublicProfile = Omit<Profile, 'apiKeySealed'> & { hasKey: boolean }
export type SessionSummary = Omit<Session, 'history' | 'transcript'>

interface TokenRecord {
  hash: string
  userId: string
  expiresAt: number
}

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const USERNAME = /^[a-zA-Z0-9_.-]{2,32}$/

export function defaultDataDir(): string {
  return process.env.HARNESS_HOME || path.join(os.homedir(), '.forge-harness')
}

function now(): string {
  return new Date().toISOString()
}

function newId(prefix: string): string {
  return `${prefix}_${randomToken(9)}`
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export class Store {
  readonly dataDir: string
  private readonly key: Buffer

  constructor(dataDir = defaultDataDir()) {
    this.dataDir = dataDir
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.key = loadMasterKey(dataDir)
  }

  private file(name: string): string {
    return path.join(this.dataDir, name)
  }

  // ---- users -------------------------------------------------------------

  private users(): User[] {
    return readJson<User[]>(this.file('users.json'), [])
  }

  private saveUsers(users: User[]): void {
    writeJson(this.file('users.json'), users)
  }

  needsSetup(): boolean {
    return this.users().length === 0
  }

  createUser(input: { username: string; password: string; isAdmin?: boolean; workspaceRoots?: string[] }): PublicUser {
    const username = input.username.trim()
    if (!USERNAME.test(username)) throw new UserError('username must be 2-32 letters, digits, "_", "." or "-"')
    if (input.password.length < 8) throw new UserError('password must be at least 8 characters')
    const users = this.users()
    if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw new UserError('username already taken')
    const user: User = {
      id: newId('usr'),
      username,
      passwordHash: hashPassword(input.password),
      isAdmin: Boolean(input.isAdmin),
      workspaceRoots: input.workspaceRoots?.length
        ? input.workspaceRoots.map((dir) => path.resolve(dir))
        : [path.join(this.dataDir, 'workspaces', username)],
      createdAt: now(),
    }
    for (const dir of user.workspaceRoots) fs.mkdirSync(dir, { recursive: true })
    users.push(user)
    this.saveUsers(users)
    return publicUser(user)
  }

  listUsers(): PublicUser[] {
    return this.users().map(publicUser)
  }

  getUser(id: string): PublicUser | undefined {
    const user = this.users().find((u) => u.id === id)
    return user && publicUser(user)
  }

  updateUser(id: string, patch: { password?: string; isAdmin?: boolean; workspaceRoots?: string[] }): PublicUser {
    const users = this.users()
    const user = users.find((u) => u.id === id)
    if (!user) throw new NotFound('user not found')
    if (patch.password !== undefined) {
      if (patch.password.length < 8) throw new UserError('password must be at least 8 characters')
      user.passwordHash = hashPassword(patch.password)
    }
    if (patch.isAdmin !== undefined) {
      if (!patch.isAdmin && user.isAdmin && users.filter((u) => u.isAdmin).length === 1) {
        throw new UserError('cannot remove the last admin')
      }
      user.isAdmin = patch.isAdmin
    }
    if (patch.workspaceRoots) user.workspaceRoots = patch.workspaceRoots.map((dir) => path.resolve(dir))
    this.saveUsers(users)
    return publicUser(user)
  }

  deleteUser(id: string): void {
    const users = this.users()
    const user = users.find((u) => u.id === id)
    if (!user) throw new NotFound('user not found')
    if (user.isAdmin && users.filter((u) => u.isAdmin).length === 1) throw new UserError('cannot delete the last admin')
    this.saveUsers(users.filter((u) => u.id !== id))
    this.saveProfiles(this.profiles().filter((p) => p.userId !== id))
    this.saveTokens(this.tokens().filter((t) => t.userId !== id))
    fs.rmSync(path.join(this.dataDir, 'sessions', id), { recursive: true, force: true })
  }

  // ---- auth tokens -------------------------------------------------------

  private tokens(): TokenRecord[] {
    return readJson<TokenRecord[]>(this.file('tokens.json'), [])
  }

  private saveTokens(tokens: TokenRecord[]): void {
    writeJson(this.file('tokens.json'), tokens)
  }

  login(username: string, password: string): { token: string; user: PublicUser } | null {
    const user = this.users().find((u) => u.username.toLowerCase() === username.trim().toLowerCase())
    // Hash even when the user is missing so timing does not reveal valid usernames.
    const ok = verifyPassword(password, user?.passwordHash ?? hashPassword('x'.repeat(12)))
    if (!user || !ok) return null
    const token = randomToken()
    const live = this.tokens().filter((t) => t.expiresAt > Date.now())
    live.push({ hash: sha256(token), userId: user.id, expiresAt: Date.now() + TOKEN_TTL_MS })
    this.saveTokens(live)
    return { token, user: publicUser(user) }
  }

  userForToken(token: string): PublicUser | undefined {
    const hash = sha256(token)
    const record = this.tokens().find((t) => t.hash === hash && t.expiresAt > Date.now())
    return record ? this.getUser(record.userId) : undefined
  }

  logout(token: string): void {
    const hash = sha256(token)
    this.saveTokens(this.tokens().filter((t) => t.hash !== hash))
  }

  // ---- provider profiles -------------------------------------------------

  private profiles(): Profile[] {
    return readJson<Profile[]>(this.file('profiles.json'), [])
  }

  private saveProfiles(profiles: Profile[]): void {
    writeJson(this.file('profiles.json'), profiles)
  }

  listProfiles(userId: string): PublicProfile[] {
    return this.profiles().filter((p) => p.userId === userId).map(publicProfile)
  }

  getProfile(userId: string, id: string): PublicProfile {
    const profile = this.profiles().find((p) => p.id === id && p.userId === userId)
    if (!profile) throw new NotFound('profile not found')
    return publicProfile(profile)
  }

  profileApiKey(userId: string, id: string): string | undefined {
    const profile = this.profiles().find((p) => p.id === id && p.userId === userId)
    if (!profile) throw new NotFound('profile not found')
    return profile.apiKeySealed ? decryptSecret(profile.apiKeySealed, this.key) : undefined
  }

  createProfile(userId: string, input: ProfileInput): PublicProfile {
    const profile: Profile = {
      id: newId('prf'),
      userId,
      createdAt: now(),
      ...validateProfile(input, undefined),
    }
    if (input.apiKey) this.sealKey(profile, input.apiKey)
    if (profile.provider === 'anthropic' && !profile.apiKeySealed) throw new UserError('an Anthropic profile needs an API key')
    const profiles = this.profiles()
    if (profiles.some((p) => p.userId === userId && p.name.toLowerCase() === profile.name.toLowerCase())) {
      throw new UserError('you already have a profile with that name')
    }
    profiles.push(profile)
    this.saveProfiles(profiles)
    return publicProfile(profile)
  }

  updateProfile(userId: string, id: string, input: Partial<ProfileInput>): PublicProfile {
    const profiles = this.profiles()
    const profile = profiles.find((p) => p.id === id && p.userId === userId)
    if (!profile) throw new NotFound('profile not found')
    Object.assign(profile, validateProfile({ ...profile, ...input } as ProfileInput, profile))
    if (input.apiKey) this.sealKey(profile, input.apiKey)
    this.saveProfiles(profiles)
    return publicProfile(profile)
  }

  deleteProfile(userId: string, id: string): void {
    const profiles = this.profiles()
    if (!profiles.some((p) => p.id === id && p.userId === userId)) throw new NotFound('profile not found')
    this.saveProfiles(profiles.filter((p) => !(p.id === id && p.userId === userId)))
  }

  private sealKey(profile: Profile, apiKey: string): void {
    const key = apiKey.trim()
    profile.apiKeySealed = encryptSecret(key, this.key)
    profile.apiKeyHint = key.length > 8 ? `…${key.slice(-4)}` : '…'
  }

  // ---- server settings -----------------------------------------------------

  private settings(): StoredSettings {
    return readJson<StoredSettings>(this.file('settings.json'), { search: { provider: 'none' } })
  }

  publicSettings(): PublicSettings {
    const { search } = this.settings()
    return { search: { provider: search.provider, baseUrl: search.baseUrl, hasKey: Boolean(search.apiKeySealed) } }
  }

  searchConfig(): SearchConfig | undefined {
    const { search } = this.settings()
    if (search.provider === 'none') return undefined
    return { provider: search.provider, baseUrl: search.baseUrl, apiKey: search.apiKeySealed ? decryptSecret(search.apiKeySealed, this.key) : undefined }
  }

  updateSettings(patch: { search?: { provider?: SearchProvider; baseUrl?: string; apiKey?: string } }): PublicSettings {
    const settings = this.settings()
    if (patch.search) {
      const provider = patch.search.provider ?? settings.search.provider
      if (!['none', 'brave', 'searxng'].includes(provider)) throw new UserError('search provider must be none, brave or searxng')
      const baseUrl = patch.search.baseUrl !== undefined ? patch.search.baseUrl.trim() || undefined : settings.search.baseUrl
      if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new UserError('base URL must start with http:// or https://')
      settings.search = {
        provider,
        baseUrl,
        apiKeySealed: patch.search.apiKey ? encryptSecret(patch.search.apiKey.trim(), this.key) : settings.search.apiKeySealed,
      }
      if (provider === 'searxng' && !baseUrl) throw new UserError('SearXNG needs a base URL')
      if (provider === 'brave' && !settings.search.apiKeySealed) throw new UserError('Brave Search needs an API key')
    }
    writeJson(this.file('settings.json'), settings)
    return this.publicSettings()
  }

  // ---- sessions ----------------------------------------------------------

  private sessionFile(userId: string, id: string): string {
    if (!/^ses_[A-Za-z0-9_-]+$/.test(id)) throw new NotFound('session not found')
    return path.join(this.dataDir, 'sessions', userId, `${id}.json`)
  }

  createSession(user: PublicUser, input: { profileId: string; model?: string; workspace?: string; title?: string; mode?: PermissionMode; web?: boolean }): Session {
    const profile = this.getProfile(user.id, input.profileId)
    const workspace = path.resolve(input.workspace || user.workspaceRoots[0] || process.cwd())
    if (!workspaceAllowed(user, workspace)) {
      throw new UserError(`workspace must be inside one of: ${user.workspaceRoots.join(', ')}`)
    }
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new UserError('workspace directory does not exist')
    const session: Session = {
      id: newId('ses'),
      userId: user.id,
      profileId: profile.id,
      provider: profile.provider,
      model: input.model?.trim() || profile.model,
      title: input.title?.trim() || 'New session',
      workspace,
      mode: input.mode === 'auto' ? 'auto' : 'ask',
      web: input.web ?? true,
      history: [],
      transcript: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: now(),
      updatedAt: now(),
    }
    this.saveSession(session)
    return session
  }

  getSession(userId: string, id: string): Session {
    const file = this.sessionFile(userId, id)
    if (!fs.existsSync(file)) throw new NotFound('session not found')
    return readJson<Session>(file, null as unknown as Session)
  }

  saveSession(session: Session): void {
    session.updatedAt = now()
    writeJson(this.sessionFile(session.userId, session.id), session)
  }

  listSessions(userId: string): SessionSummary[] {
    const dir = path.join(this.dataDir, 'sessions', userId)
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson<Session | null>(path.join(dir, name), null))
      .filter((s): s is Session => Boolean(s))
      .map(({ history: _h, transcript: _t, ...summary }) => summary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  deleteSession(userId: string, id: string): void {
    const file = this.sessionFile(userId, id)
    if (!fs.existsSync(file)) throw new NotFound('session not found')
    fs.rmSync(file)
  }
}

export interface ProfileInput {
  name: string
  provider: ProviderKind
  model: string
  baseUrl?: string
  apiKey?: string
  effort?: Effort
  thinking?: boolean
  fallbacks?: boolean
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

function validateProfile(input: ProfileInput, existing: Profile | undefined): Omit<Profile, 'id' | 'userId' | 'createdAt'> {
  const name = String(input.name || '').trim()
  if (!name || name.length > 40) throw new UserError('profile name must be 1-40 characters')
  if (input.provider !== 'anthropic' && input.provider !== 'openai') throw new UserError('provider must be "anthropic" or "openai"')
  const model = String(input.model || '').trim()
  if (!model) throw new UserError('model is required')
  const baseUrl = input.baseUrl ? String(input.baseUrl).trim() : undefined
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new UserError('base URL must start with http:// or https://')
  if (input.effort && !EFFORTS.includes(input.effort)) throw new UserError(`effort must be one of ${EFFORTS.join(', ')}`)
  return {
    name,
    provider: input.provider,
    model,
    baseUrl: baseUrl || undefined,
    apiKeySealed: existing?.apiKeySealed,
    apiKeyHint: existing?.apiKeyHint,
    effort: input.effort || undefined,
    thinking: input.thinking ?? existing?.thinking ?? true,
    fallbacks: input.fallbacks ?? existing?.fallbacks ?? true,
  }
}

export function workspaceAllowed(user: PublicUser, dir: string): boolean {
  if (user.isAdmin) return true
  const target = path.resolve(dir)
  return user.workspaceRoots.some((root) => {
    const rel = path.relative(path.resolve(root), target)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

function publicUser(user: User): PublicUser {
  const { passwordHash: _p, ...rest } = user
  return rest
}

function publicProfile(profile: Profile): PublicProfile {
  const { apiKeySealed, ...rest } = profile
  return { ...rest, hasKey: Boolean(apiKeySealed) }
}

export class UserError extends Error {
  readonly status = 400
}

export class NotFound extends Error {
  readonly status = 404
}
