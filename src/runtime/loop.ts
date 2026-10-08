import { randomUUID } from 'crypto'
import { localToolDefinitions, dispatchLocalTool, resolveWorkspaceRoot } from './tools'
import type { LocalTurnEvent, LocalTurnResult, ModelClient, ModelMessage, ModelRequest, ToolResult } from './types'

const DEFAULT_MAX_ROUNDS = 8

export interface RunLocalTurnOptions {
  prompt: string
  cwd?: string
  model: string
  client: ModelClient
  messages?: ModelMessage[]
  conversationId?: string
  maxRounds?: number
}

export async function* runLocalTurn(options: RunLocalTurnOptions): AsyncGenerator<LocalTurnEvent, LocalTurnResult> {
  const prompt = options.prompt.trim()
  if (!prompt) throw new Error('prompt is required')
  const cwd = resolveWorkspaceRoot(options.cwd)
  const conversationId = options.conversationId || randomUUID()
  yield { type: 'bound', text: conversationId }

  const messages: ModelMessage[] = [...(options.messages || []), { role: 'user', content: prompt }]
  const tools = localToolDefinitions()
  const toolResults: ToolResult[] = []
  const requests: ModelRequest[] = []
  let text = ''
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS

  for (let round = 0; round < maxRounds; round += 1) {
    const request: ModelRequest = { model: options.model, messages: messages.map((row) => ({ ...row })), tools }
    requests.push(request)
    let completion = await options.client.complete(request)
    if (!completion.text && !completion.tool_calls.length) {
      completion = await options.client.complete(request)
    }
    if (completion.text) {
      text += completion.text
      yield { type: 'text', text: completion.text }
    }
    if (!completion.tool_calls.length) {
      return { conversationId, text, toolResults, requests }
    }
    messages.push({
      role: 'assistant',
      content: completion.text || '',
      tool_calls: completion.tool_calls,
    })
    for (const call of completion.tool_calls) {
      const result = dispatchLocalTool(cwd, {
        ...call,
        id: call.id || randomUUID(),
        arguments: call.arguments || {},
      })
      toolResults.push(result)
      yield { type: 'tool', text: `${result.name} · ${result.ok ? 'ok' : 'error'} · ${result.content}` }
      messages.push({
        role: 'tool',
        name: result.name,
        tool_call_id: result.id,
        content: result.content,
      })
    }
  }
  yield { type: 'status', text: `stopped after ${maxRounds} tool rounds` }
  return { conversationId, text, toolResults, requests }
}

export async function collectLocalTurn(options: RunLocalTurnOptions): Promise<LocalTurnResult> {
  const gen = runLocalTurn(options)
  let step = await gen.next()
  while (!step.done) step = await gen.next()
  return step.value
}

export function createLaunchStubModel(): ModelClient {
  let step = 0
  return {
    async complete(request) {
      step += 1
      if (step === 1) {
        return {
          text: '',
          tool_calls: [{ id: 'stub-read', name: 'read_file', arguments: { target_file: 'hello.txt' } }],
        }
      }
      const lastTool = [...request.messages].reverse().find((row) => row.role === 'tool')
      return { text: `local tool result:\n${lastTool?.content || ''}`, tool_calls: [] }
    },
  }
}

export function createScriptedModel(script: Array<{ text?: string; tool_calls?: import('./types').ToolCall[] }>): ModelClient {
  const remaining = [...script]
  return {
    async complete() {
      const next = remaining.shift()
      if (!next) return { text: '', tool_calls: [] }
      return { text: next.text || '', tool_calls: next.tool_calls || [] }
    },
  }
}
