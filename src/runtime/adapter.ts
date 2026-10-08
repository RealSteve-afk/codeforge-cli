import { clientStamp, type CodeForgeClientKind } from '../client'
import { authHeaders, errorDetail, HttpClient } from '../http'
import { consumeSse, sseEventText } from '../sse'
import { ensureConversationId } from '../store'
import { COMPLETE_PATH, OPENAI_COMPAT_PATH } from './suite'
import type { ModelClient, ModelCompletion, ModelMessage, ModelRequest, ToolCall } from './types'

export interface CompleteRequestBody {
  model: string
  messages: Array<Record<string, unknown>>
  tools: ModelRequest['tools']
  stream?: boolean
  client: CodeForgeClientKind
  client_version: string
  client_request_id: string
}


export function toProviderMessages(messages: ModelMessage[]): Array<Record<string, unknown>> {
  return messages.map((row) => {
    const out: Record<string, unknown> = { role: row.role, content: row.content }
    if (row.tool_call_id) out.tool_call_id = row.tool_call_id
    if (row.name) out.name = row.name
    if (row.tool_calls?.length) {
      out.tool_calls = row.tool_calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments || {}),
        },
      }))
    }
    return out
  })
}

export function completeUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, '')}${COMPLETE_PATH}`
}

export function openaiCompatUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, '')}${OPENAI_COMPAT_PATH}`
}

export function completeHeaders(token: string, conversationId?: string): Record<string, string> {
  return {
    ...authHeaders(token),
    'x-codeforge-conversation-id': conversationId || ensureConversationId(),
  }
}

export function buildCompleteRequest(
  request: ModelRequest,
  options: { client?: CodeForgeClientKind } = {},
): CompleteRequestBody {
  const stamp = clientStamp(options.client || 'cli')
  return {
    model: request.model,
    messages: toProviderMessages(request.messages),
    tools: request.tools,
    stream: true,
    client: stamp.client,
    client_version: stamp.client_version,
    client_request_id: stamp.client_request_id,
  }
}

export function isServerSideAgentPayload(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const row = body as Record<string, unknown>
  return row.task_category === 'coding' && typeof row.message === 'string' && !Array.isArray(row.messages)
}

function asToolCall(raw: unknown, index: number): ToolCall | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const fn = row.function && typeof row.function === 'object' ? (row.function as Record<string, unknown>) : row
  const name = String(fn.name || row.name || '')
  if (!name) return null
  let args: Record<string, unknown> = {}
  const rawArgs = fn.arguments ?? row.arguments ?? row.input
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>
    } catch {
      args = { raw: rawArgs }
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs as Record<string, unknown>
  }
  return { id: String(row.id || `call_${index}`), name, arguments: args }
}

export function parseCompleteSse(buffer: string): ModelCompletion {
  const parsed = consumeSse(buffer.endsWith('\n\n') ? buffer : `${buffer}\n\n`)
  let text = ''
  const tool_calls: ToolCall[] = []
  for (const event of parsed.events) {
    if (event.type === 'error') {
      throw new Error(typeof event.data === 'string' ? event.data : 'stream error')
    }
    if (event.name === 'tool_call') {
      const mapped = asToolCall(event.data, tool_calls.length)
      if (mapped) tool_calls.push(mapped)
      continue
    }
    if (event.name === 'delta' || event.type === 'text' || event.name === 'text') {
      const chunk = sseEventText(event)
      if (chunk) text += chunk
    }
    if (event.data && typeof event.data === 'object') {
      const row = event.data as Record<string, unknown>
      if (Array.isArray(row.tool_calls)) {
        row.tool_calls.forEach((item, index) => {
          const mapped = asToolCall(item, tool_calls.length + index)
          if (mapped) tool_calls.push(mapped)
        })
      }
      if (typeof row.content === 'string') text += row.content
    }
  }
  return { text, tool_calls }
}

export function parseOpenAiChatCompletion(body: unknown): ModelCompletion {
  const row = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const choices = Array.isArray(row.choices) ? row.choices : []
  const first = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : {}
  const message = first.message && typeof first.message === 'object' ? (first.message as Record<string, unknown>) : first
  const text = typeof message.content === 'string' ? message.content : ''
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const tool_calls = rawCalls
    .map((item, index) => asToolCall(item, index))
    .filter((item): item is ToolCall => Boolean(item))
  return { text, tool_calls }
}

export function createCodeForgeCloudModel(
  http: HttpClient,
  options: { apiBase: string; token: string; client?: CodeForgeClientKind; conversationId?: string },
): ModelClient {
  return {
    async complete(request) {
      const payload = buildCompleteRequest(request, { client: options.client })
      if (isServerSideAgentPayload(payload)) {
        throw new Error('refusing server-side /api/chat/send agent payload')
      }
      const sent = await http(completeUrl(options.apiBase), {
        method: 'POST',
        headers: completeHeaders(options.token, options.conversationId),
        body: JSON.stringify(payload),
      })
      if (!sent.ok) {
        const body = await sent.json().catch(() => ({}))
        throw new Error(errorDetail(body, `complete failed (${sent.status})`))
      }
      const stream = sent.stream
      if (stream) {
        let buffer = ''
        for await (const chunk of stream()) buffer += chunk
        return parseCompleteSse(buffer)
      }
      const raw = await sent.text()
      if (raw.trim().startsWith('{')) {
        try {
          return parseOpenAiChatCompletion(JSON.parse(raw))
        } catch {
                  }
      }
      return parseCompleteSse(raw)
    },
  }
}
