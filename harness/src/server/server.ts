import fs from 'fs'
import http from 'http'
import path from 'path'
import { Agent, type Run } from '../core/agent'
import { listProviderModels } from '../core/providers/models'
import type { AgentEvent } from '../core/providers/types'
import { NotFound, type ProfileInput, type PublicUser, Store, UserError } from '../core/store'

export interface ServerOptions {
  store: Store
  agent?: Agent
  webDir?: string
}

type Params = Record<string, string>
interface Ctx {
  req: http.IncomingMessage
  res: http.ServerResponse
  params: Params
  user?: PublicUser
  token?: string
  body: any
}
type Handler = (ctx: Ctx) => Promise<unknown> | unknown

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const MAX_BODY = 1_000_000
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

export function defaultWebDir(): string {
  return path.resolve(__dirname, '..', '..', 'web')
}

export function createServer(options: ServerOptions): http.Server {
  const { store } = options
  const agent = options.agent ?? new Agent(store)
  const webDir = options.webDir ?? defaultWebDir()
  const routes: Array<{ method: string; pattern: RegExp; keys: string[]; auth: boolean; handler: Handler }> = []

  const route = (method: string, pathPattern: string, handler: Handler, auth = true): void => {
    const keys: string[] = []
    const pattern = new RegExp(
      `^${pathPattern.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
        keys.push(key)
        return '([^/]+)'
      })}$`,
    )
    routes.push({ method, pattern, keys, auth, handler })
  }
  const admin = (ctx: Ctx): void => {
    if (!ctx.user?.isAdmin) throw new HttpError(403, 'admin only')
  }

  // ---- setup & auth --------------------------------------------------------

  route('GET', '/api/setup', () => ({ needsSetup: store.needsSetup() }), false)
  route(
    'POST',
    '/api/setup',
    ({ body }) => {
      if (!store.needsSetup()) throw new HttpError(409, 'setup is already done')
      store.createUser({ username: body.username, password: body.password, isAdmin: true, workspaceRoots: body.workspaceRoots })
      return store.login(body.username, body.password)
    },
    false,
  )
  route(
    'POST',
    '/api/login',
    async ({ body }) => {
      const result = store.login(String(body.username ?? ''), String(body.password ?? ''))
      if (!result) {
        await new Promise((r) => setTimeout(r, 400))
        throw new HttpError(401, 'wrong username or password')
      }
      return result
    },
    false,
  )
  route('POST', '/api/logout', ({ token }) => {
    store.logout(token!)
    return { ok: true }
  })
  route('GET', '/api/me', ({ user }) => user)
  route('POST', '/api/me/password', ({ user, body }) => {
    if (!store.login(user!.username, String(body.currentPassword ?? ''))) throw new HttpError(401, 'current password is wrong')
    return store.updateUser(user!.id, { password: String(body.newPassword ?? '') })
  })

  // ---- users (admin) -------------------------------------------------------

  route('GET', '/api/users', (ctx) => {
    admin(ctx)
    return store.listUsers()
  })
  route('POST', '/api/users', (ctx) => {
    admin(ctx)
    const { username, password, isAdmin, workspaceRoots } = ctx.body
    return store.createUser({ username, password, isAdmin, workspaceRoots })
  })
  route('PATCH', '/api/users/:id', (ctx) => {
    admin(ctx)
    const { password, isAdmin, workspaceRoots } = ctx.body
    return store.updateUser(ctx.params.id, { password, isAdmin, workspaceRoots })
  })
  route('DELETE', '/api/users/:id', (ctx) => {
    admin(ctx)
    if (ctx.params.id === ctx.user!.id) throw new HttpError(400, 'you cannot delete your own account')
    store.deleteUser(ctx.params.id)
    return { ok: true }
  })

  // ---- server settings (web search backend) ----------------------------------

  route('GET', '/api/settings', () => store.publicSettings())
  route('PATCH', '/api/settings', (ctx) => {
    admin(ctx)
    return store.updateSettings({ search: ctx.body.search })
  })

  // ---- provider profiles ---------------------------------------------------

  route('GET', '/api/profiles', ({ user }) => store.listProfiles(user!.id))
  route('POST', '/api/profiles', ({ user, body }) => store.createProfile(user!.id, body as ProfileInput))
  route('PATCH', '/api/profiles/:id', ({ user, body, params }) => store.updateProfile(user!.id, params.id, body as Partial<ProfileInput>))
  route('GET', '/api/profiles/:id/models', async ({ user, params }) => {
    const profile = store.getProfile(user!.id, params.id)
    try {
      return { models: await listProviderModels(profile, store.profileApiKey(user!.id, params.id)) }
    } catch (error) {
      // Some OpenAI-compatible servers have no models endpoint; the GUI then offers a free-text model field.
      return { models: [], error: `could not list models: ${(error as Error).message}` }
    }
  })
  route('DELETE', '/api/profiles/:id', ({ user, params }) => {
    store.deleteProfile(user!.id, params.id)
    return { ok: true }
  })

  // ---- sessions ------------------------------------------------------------

  route('GET', '/api/sessions', ({ user }) =>
    store.listSessions(user!.id).map((s) => ({ ...s, running: Boolean(agent.activeRun(user!.id, s.id) && !agent.activeRun(user!.id, s.id)!.done) })),
  )
  route('POST', '/api/sessions', ({ user, body }) => {
    const { history: _h, ...session } = store.createSession(user!, body)
    return session
  })
  route('GET', '/api/sessions/:id', ({ user, params }) => {
    const { history: _h, ...session } = store.getSession(user!.id, params.id)
    const run = agent.activeRun(user!.id, params.id)
    return { ...session, running: Boolean(run && !run.done) }
  })
  route('PATCH', '/api/sessions/:id', ({ user, params, body }) => {
    const session = store.getSession(user!.id, params.id)
    if (typeof body.title === 'string' && body.title.trim()) session.title = body.title.trim().slice(0, 100)
    if (body.mode === 'ask' || body.mode === 'auto') session.mode = body.mode
    if (typeof body.web === 'boolean') session.web = body.web
    store.saveSession(session)
    const { history: _h, ...rest } = session
    return rest
  })
  route('DELETE', '/api/sessions/:id', ({ user, params }) => {
    agent.cancel(user!.id, params.id)
    store.deleteSession(user!.id, params.id)
    return { ok: true }
  })
  route('POST', '/api/sessions/:id/messages', ({ user, params, body, req, res }) => {
    const run = agent.start(user!, params.id, String(body.text ?? ''))
    streamRun(run, req, res)
    return STREAMING
  })
  route('GET', '/api/sessions/:id/stream', ({ user, params, req, res }) => {
    const run = agent.activeRun(user!.id, params.id)
    if (!run) throw new HttpError(404, 'no turn is running in this session')
    streamRun(run, req, res)
    return STREAMING
  })
  route('POST', '/api/sessions/:id/approvals/:approvalId', ({ user, params, body }) => {
    agent.resolveApproval(user!.id, params.id, params.approvalId, Boolean(body.allow), Boolean(body.always))
    return { ok: true }
  })
  route('POST', '/api/sessions/:id/model', ({ user, params, body }) => {
    const { history: _h, ...session } = agent.switchModel(user!, params.id, { profileId: body.profileId, model: body.model })
    return { ...session, running: false }
  })
  route('POST', '/api/sessions/:id/answers/:questionId', ({ user, params, body }) => {
    agent.answerQuestion(user!.id, params.id, params.questionId, String(body.answer ?? ''))
    return { ok: true }
  })
  route('POST', '/api/sessions/:id/cancel', ({ user, params }) => ({ cancelled: agent.cancel(user!.id, params.id) }))

  return http.createServer((req, res) => {
    handle(req, res).catch((error) => sendError(res, error))
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return serveStatic(webDir, url.pathname, res)

    // Requests from other web origins are refused (protects a localhost server from drive-by pages).
    const origin = req.headers.origin
    if (origin && originHost(origin) !== req.headers.host) throw new HttpError(403, 'cross-origin request refused')

    const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname))
    if (!match) throw new HttpError(404, 'not found')
    const values = match.pattern.exec(url.pathname)!.slice(1)
    const params: Params = Object.fromEntries(match.keys.map((key, i) => [key, decodeURIComponent(values[i])]))
    const ctx: Ctx = { req, res, params, body: await readBody(req) }
    if (match.auth) {
      const header = req.headers.authorization ?? ''
      const token = header.startsWith('Bearer ') ? header.slice(7) : ''
      const user = token ? store.userForToken(token) : undefined
      if (!user) throw new HttpError(401, 'please log in')
      ctx.user = user
      ctx.token = token
    }
    const result = await match.handler(ctx)
    if (result === STREAMING) return
    sendJson(res, 200, result ?? { ok: true })
  }
}

const STREAMING = Symbol('streaming')

function originHost(origin: string): string | undefined {
  try {
    return new URL(origin).host
  } catch {
    return undefined
  }
}

function streamRun(run: Run, req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(`event: run\ndata: ${JSON.stringify({ runId: run.id })}\n\n`)
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
  let unsubscribe: () => void = () => undefined
  const close = (): void => {
    clearInterval(keepAlive)
    unsubscribe()
    res.end()
  }
  unsubscribe = run.subscribe((event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
    if (event.type === 'done') setImmediate(close)
  })
  // A client that disconnects only detaches; the turn keeps running and can be re-attached.
  req.on('close', () => {
    clearInterval(keepAlive)
    unsubscribe()
  })
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  if (req.method === 'GET' || req.method === 'HEAD') return {}
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large')
    chunks.push(chunk as Buffer)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'request body must be JSON')
  }
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function sendError(res: http.ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const status = error instanceof HttpError ? error.status : error instanceof UserError || error instanceof NotFound ? error.status : 500
  const message = status === 500 ? 'internal error' : (error as Error).message
  if (status === 500) console.error(error)
  sendJson(res, status, { error: message })
}

function serveStatic(webDir: string, pathname: string, res: http.ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const file = path.resolve(webDir, rel)
  if (!file.startsWith(webDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:",
  })
  fs.createReadStream(file).pipe(res)
}

export function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    })
  })
}
