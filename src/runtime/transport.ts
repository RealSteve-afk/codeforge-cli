import { randomUUID } from 'crypto'
import type { HttpClient } from '../http'
import type { TurnEvent, TurnTransport, CloudMessage } from '../transport'
import { readSession, requireAuth, writeSession } from '../store'
import { createCodeForgeCloudModel } from './adapter'
import { collectLocalTurn, runLocalTurn } from './loop'
import { resolveRuntimeModel } from './models'
import { createLocalSession, listLocalSessions, loadLocalSession, saveLocalSession } from './sessions'
import { resolveWorkspaceRoot } from './tools'
import type { ModelClient } from './types'

export function createLocalRuntimeTransport(
  http: HttpClient,
  options: { cwd?: string; modelClient?: ModelClient; client?: 'tui' | 'cli' } = {},
): TurnTransport {
  return {
    async *send(prompt, sendOptions = {}) {
      const cwd = resolveWorkspaceRoot(options.cwd)
      let conversationId = sendOptions.conversationId || (!sendOptions.newConversation ? readSession().last_conversation_id : '') || ''
      let existing = conversationId ? loadLocalSession(conversationId) : null
      if (!existing || sendOptions.newConversation) {
        conversationId = randomUUID()
        writeSession({ ...readSession(), last_conversation_id: conversationId })
        existing = createLocalSession(prompt.trim().slice(0, 50), cwd, readSession().last_model, conversationId)
      } else {
        writeSession({ ...readSession(), last_conversation_id: conversationId })
      }
      const client = options.modelClient || cloudClient(http, options.client || 'tui', conversationId)
      const model = options.modelClient
        ? existing.model || readSession().last_model || 'stub'
        : await resolveRuntimeModel(http, { explicit: existing.model || readSession().last_model })
      const gen = runLocalTurn({
        prompt,
        cwd,
        model,
        client,
        messages: existing.messages,
        conversationId,
      })
      let step = await gen.next()
      while (!step.done) {
        const event = step.value as TurnEvent
        yield event
        step = await gen.next()
      }
      const result = step.value
      existing.messages.push({ role: 'user', content: prompt })
      if (result.text) existing.messages.push({ role: 'assistant', content: result.text })
      saveLocalSession(existing)
      return { conversationId: result.conversationId }
    },

    async listConversations() {
      return listLocalSessions().map((row) => ({ id: row.id, title: row.title, client: 'tui' }))
    },

    async getConversation(id) {
      const row = loadLocalSession(id)
      if (!row) throw new Error('conversation not found')
      const messages: CloudMessage[] = row.messages.map((message, index) => ({
        id: `${row.id}-${index}`,
        role: message.role === 'tool' ? 'assistant' : message.role,
        content: message.content,
        ...(message.role === 'tool' ? { message_type: 'tool_result' } : {}),
      }))
      return { id: row.id, title: row.title, messages }
    },
  }
}

export async function execLocalTurn(
  prompt: string,
  options: {
    cwd?: string
    model?: string
    conversationId?: string
    newConversation?: boolean
    modelClient?: ModelClient
    http?: HttpClient
    client?: 'tui' | 'cli'
  } = {},
): Promise<{ conversationId: string; text: string; toolResults: import('./types').ToolResult[] }> {
  const cwd = resolveWorkspaceRoot(options.cwd)
  let conversationId = options.conversationId || (!options.newConversation ? readSession().last_conversation_id : '') || ''
  if (options.newConversation || !conversationId) {
    conversationId = randomUUID()
    writeSession({ ...readSession(), last_conversation_id: conversationId })
  }
  let existing = conversationId ? loadLocalSession(conversationId) : null
  if (!existing) {
    existing = createLocalSession(prompt.trim().slice(0, 50), cwd, options.model, conversationId)
  }
  const client = options.modelClient || (options.http ? cloudClient(options.http, options.client || 'cli', conversationId) : undefined)
  if (!client) throw new Error('model client required')
  const result = await collectLocalTurn({
    prompt,
    cwd,
    model: options.model || existing.model || readSession().last_model || 'stub',
    client,
    messages: existing.messages,
    conversationId,
  })
  existing.messages.push({ role: 'user', content: prompt })
  if (result.text) existing.messages.push({ role: 'assistant', content: result.text })
  saveLocalSession(existing)
  writeSession({ ...readSession(), last_conversation_id: result.conversationId, last_model: options.model || readSession().last_model })
  return { conversationId: result.conversationId, text: result.text, toolResults: result.toolResults }
}

function cloudClient(http: HttpClient, client: 'tui' | 'cli', conversationId?: string): ModelClient {
  const auth = requireAuth()
  return createCodeForgeCloudModel(http, {
    apiBase: auth.api_base,
    token: auth.token,
    client,
    conversationId,
  })
}
