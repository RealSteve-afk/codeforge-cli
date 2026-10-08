import { clientStamp } from './client'
import { summarizeLiveTool } from './toolSummary'
import { authHeaders, errorDetail, HttpClient, HttpResponse } from './http'
import { consumeSse, SseEvent, sseEventText } from './sse'
import { readSession, requireAuth, writeSession } from './store'

export interface CloudMessage {
  id: string
  role: string
  content: string
  message_type?: string | null
  content_blocks?: Array<{
    type?: string
    name?: string
    tool?: string
    content?: unknown
    text?: string
    description?: string
    result_summary?: string
    result_preview?: string
    success?: boolean
    input?: unknown
  }> | null
}

export interface TurnEvent {
  type: 'text' | 'error' | 'status' | 'bound' | 'tool'
  text?: string
}

export interface TurnTransport {
  send(
    prompt: string,
    options?: { conversationId?: string; newConversation?: boolean },
  ): AsyncGenerator<TurnEvent, { conversationId: string }>
  listConversations(): Promise<Array<{ id: string; title: string; client?: string }>>
  getConversation(id: string): Promise<{ id: string; title: string; messages: CloudMessage[] }>
}

function errorEventText(event: SseEvent): string {
  if (typeof event.data === 'string') return event.data
  if (event.data && typeof event.data === 'object') {
    const message = (event.data as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return 'stream error'
}

export function mapSseEventToTurn(event: SseEvent): TurnEvent | null {
  if (event.type === 'error') return { type: 'error', text: errorEventText(event) }
  if (event.type === 'text') {
    const text = sseEventText(event)
    return text ? { type: 'text', text } : null
  }
  if (event.name === 'tool_call' || event.name === 'tool_status') {
    const data = event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : {}
    const text = summarizeLiveTool(data, event.name)
    return text ? { type: 'tool', text } : null
  }
  return null
}

async function* responseChunks(response: HttpResponse): AsyncIterable<string> {
  if (response.stream) {
    yield* response.stream()
    return
  }
  yield await response.text()
}

function turnEventsFrom(buffer: string): { events: TurnEvent[]; rest: string } {
  const parsed = consumeSse(buffer)
  const events: TurnEvent[] = []
  for (const event of parsed.events) {
    const mapped = mapSseEventToTurn(event)
    if (mapped) events.push(mapped)
  }
  return { events, rest: parsed.rest }
}

export function createFastApiTransport(http: HttpClient): TurnTransport {
  return {
    async *send(prompt, options = {}) {
      const auth = requireAuth()
      const text = prompt.trim()
      if (!text) throw new Error('prompt is required')
      const stamp = clientStamp('tui')
      const session = readSession()

      let conversationId =
        options.conversationId || (!options.newConversation ? session.last_conversation_id : '') || ''
      if (!conversationId) {
        const created = await http(`${auth.api_base}/api/chat/conversations`, {
          method: 'POST',
          headers: authHeaders(auth.token),
          body: JSON.stringify({
            title: text.slice(0, 50),
            model: session.last_model || undefined,
            project_id: session.last_project_id || undefined,
            client: stamp.client,
            client_version: stamp.client_version,
          }),
        })
        const body = await created.json().catch(() => ({}))
        if (!created.ok) throw new Error(errorDetail(body, `create conversation failed (${created.status})`))
        conversationId = String(body.id || '')
        if (!conversationId) throw new Error('create conversation missing id')
      }

      writeSession({
        ...readSession(),
        last_conversation_id: conversationId,
      })
      yield { type: 'bound', text: conversationId }

      const sent = await http(`${auth.api_base}/api/chat/send`, {
        method: 'POST',
        headers: authHeaders(auth.token),
        body: JSON.stringify({
          conversation_id: conversationId,
          message: text,
          model: session.last_model || undefined,
          task_category: 'coding',
          client: stamp.client,
          client_version: stamp.client_version,
          client_request_id: stamp.client_request_id,
        }),
      })
      if (!sent.ok) {
        const body = await sent.json().catch(() => ({}))
        throw new Error(errorDetail(body, `exec failed (${sent.status})`))
      }

      let buffer = ''
      for await (const chunk of responseChunks(sent)) {
        const parsed = turnEventsFrom(buffer + chunk)
        buffer = parsed.rest
        for (const event of parsed.events) yield event
      }
      if (buffer.trim()) {
        const parsed = turnEventsFrom(`${buffer}\n\n`)
        for (const event of parsed.events) yield event
      }

      return { conversationId }
    },

    async listConversations() {
      const auth = requireAuth()
      const response = await http(`${auth.api_base}/api/chat/conversations?limit=30`, {
        headers: authHeaders(auth.token),
      })
      const body = await response.json().catch(() => [])
      if (!response.ok) throw new Error(errorDetail(body, `history failed (${response.status})`))
      const rows = Array.isArray(body) ? body : []
      return rows.map((row: { id?: string; title?: string; client?: string }) => ({
        id: String(row.id || ''),
        title: String(row.title || ''),
        ...(row.client ? { client: String(row.client) } : {}),
      }))
    },

    async getConversation(id) {
      const auth = requireAuth()
      const trimmed = id.trim()
      if (!trimmed) throw new Error('conversation id is required')
      const response = await http(`${auth.api_base}/api/chat/conversations/${encodeURIComponent(trimmed)}`, {
        headers: authHeaders(auth.token),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(errorDetail(body, `conversation failed (${response.status})`))
      const messages = Array.isArray(body.messages) ? body.messages : []
      return {
        id: String(body.id || trimmed),
        title: String(body.title || ''),
        messages: messages.map((row: CloudMessage) => ({
          id: String(row.id || ''),
          role: String(row.role || ''),
          content: String(row.content || ''),
          ...(row.message_type ? { message_type: String(row.message_type) } : {}),
          ...(row.content_blocks ? { content_blocks: row.content_blocks } : {}),
        })),
      }
    },
  }
}
