import type { AgentEvent } from '../core/providers/types'
import type { PublicProfile, PublicUser, Session, SessionSummary } from '../core/store'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type SessionView = Omit<Session, 'history'> & { running: boolean }

// Thin HTTP client for the harness server, used by the TUI.
export class HarnessClient {
  constructor(
    readonly baseUrl: string,
    public token = '',
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = (await response.json().catch(() => ({}))) as { error?: string }
    if (!response.ok) throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`)
    return data as T
  }

  async ping(): Promise<boolean> {
    try {
      await this.request('GET', '/api/setup')
      return true
    } catch (error) {
      return error instanceof ApiError
    }
  }

  needsSetup = async (): Promise<boolean> => (await this.request<{ needsSetup: boolean }>('GET', '/api/setup')).needsSetup
  setup = (username: string, password: string) => this.request<{ token: string; user: PublicUser }>('POST', '/api/setup', { username, password })
  login = (username: string, password: string) => this.request<{ token: string; user: PublicUser }>('POST', '/api/login', { username, password })
  logout = () => this.request('POST', '/api/logout')
  me = () => this.request<PublicUser>('GET', '/api/me')

  users = () => this.request<PublicUser[]>('GET', '/api/users')
  createUser = (input: { username: string; password: string; isAdmin?: boolean; workspaceRoots?: string[] }) =>
    this.request<PublicUser>('POST', '/api/users', input)
  deleteUser = (id: string) => this.request('DELETE', `/api/users/${id}`)

  profiles = () => this.request<PublicProfile[]>('GET', '/api/profiles')
  createProfile = (input: Record<string, unknown>) => this.request<PublicProfile>('POST', '/api/profiles', input)
  deleteProfile = (id: string) => this.request('DELETE', `/api/profiles/${id}`)
  models = (profileId: string) => this.request<{ models: string[]; error?: string }>('GET', `/api/profiles/${profileId}/models`)

  sessions = () => this.request<Array<SessionSummary & { running: boolean }>>('GET', '/api/sessions')
  session = (id: string) => this.request<SessionView>('GET', `/api/sessions/${id}`)
  createSession = (input: { profileId: string; workspace?: string; mode?: string }) => this.request<SessionView>('POST', '/api/sessions', input)
  updateSession = (id: string, patch: { title?: string; mode?: string; web?: boolean }) => this.request<SessionView>('PATCH', `/api/sessions/${id}`, patch)
  switchModel = (id: string, profileId: string, model?: string) => this.request<SessionView>('POST', `/api/sessions/${id}/model`, { profileId, model })
  answer = (sessionId: string, questionId: string, answer: string) => this.request('POST', `/api/sessions/${sessionId}/answers/${questionId}`, { answer })
  deleteSession = (id: string) => this.request('DELETE', `/api/sessions/${id}`)
  approve = (sessionId: string, approvalId: string, allow: boolean, always = false) =>
    this.request('POST', `/api/sessions/${sessionId}/approvals/${approvalId}`, { allow, always })
  cancel = (sessionId: string) => this.request('POST', `/api/sessions/${sessionId}/cancel`)

  // Sends a message and yields the turn's events until it is done.
  async *send(sessionId: string, text: string): AsyncGenerator<AgentEvent> {
    yield* this.stream('POST', `/api/sessions/${sessionId}/messages`, { text })
  }

  async *attach(sessionId: string): AsyncGenerator<AgentEvent> {
    yield* this.stream('GET', `/api/sessions/${sessionId}/stream`)
  }

  private async *stream(method: string, path: string, body?: unknown): AsyncGenerator<AgentEvent> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok || !response.body) {
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`)
    }
    yield* parseSse(response.body)
  }
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      if (/^event: /m.test(frame)) continue
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
      if (data) yield JSON.parse(data) as AgentEvent
    }
  }
}
