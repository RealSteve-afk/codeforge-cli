import fs from 'fs'
import os from 'os'
import path from 'path'
import { clientStamp } from '../client'
import type { HttpClient } from '../http'
import { readSession, writeAuth, writeSession } from '../store'
import {
  buildCompleteRequest,
  completeUrl,
  createCodeForgeCloudModel,
  isServerSideAgentPayload,
  parseCompleteSse,
  parseOpenAiChatCompletion,
  toProviderMessages,
} from './adapter'
import { localToolDefinitions } from './tools'
import type { ModelRequest } from './types'

function withCodeForgeHome(): { home: string; restore: () => void } {
  const previousHome = process.env.CODEFORGE_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-adapter-'))
  process.env.CODEFORGE_HOME = home
  writeAuth({
    token: 'jwt',
    email: 'ada@codeforge.dev',
    user_id: 'u1',
    api_base: 'https://www.codeforge.dev',
  })
  return {
    home,
    restore() {
      if (previousHome === undefined) delete process.env.CODEFORGE_HOME
      else process.env.CODEFORGE_HOME = previousHome
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}

const request: ModelRequest = {
  model: 'kimi-k2.5',
  messages: [
    { role: 'user', content: 'read hello.txt' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', name: 'read_file', arguments: { target_file: 'hello.txt' } }],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'hello codeforge' },
  ],
  tools: localToolDefinitions(),
}

it('builds a messages+tools complete payload, not /api/chat/send coding', () => {
  const body = buildCompleteRequest(request, { client: 'cli' })
  expect(completeUrl('https://www.codeforge.dev')).toBe('https://www.codeforge.dev/api/runtime/complete')
  expect(body.model).toBe('kimi-k2.5')
  expect(body.messages).toEqual(toProviderMessages(request.messages))
  expect(body.messages[1].tool_calls).toEqual([
    {
      id: 'c1',
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ target_file: 'hello.txt' }) },
    },
  ])
  expect(body.tools.map((tool) => tool.function.name)).toEqual(['read_file', 'search_replace', 'grep', 'bash'])
  expect(body.client).toBe('cli')
  expect(body.client_version).toBe(clientStamp('cli').client_version)
  expect(body.client_request_id).toBeTruthy()
  expect(isServerSideAgentPayload(body)).toBe(false)
  expect(isServerSideAgentPayload({ task_category: 'coding', message: 'hi' })).toBe(true)
  expect((body as { task_category?: string }).task_category).toBeUndefined()
  expect((body as { message?: string }).message).toBeUndefined()
})

it('parses streamed text and tool_calls from the complete wire', () => {
  const parsed = parseCompleteSse(
    [
      'event: text',
      'data: "looking\\n"',
      '',
      'event: tool_call',
      'data: {"id":"c9","name":"grep","arguments":{"pattern":"codeforge"}}',
      '',
    ].join('\n'),
  )
  expect(parsed.text).toContain('looking')
  expect(parsed.tool_calls).toEqual([{ id: 'c9', name: 'grep', arguments: { pattern: 'codeforge' } }])
})

it('parses an OpenAI-shaped completion with function tool_calls', () => {
  const parsed = parseOpenAiChatCompletion({
    choices: [
      {
        message: {
          content: 'ok',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"ls"}' },
            },
          ],
        },
      },
    ],
  })
  expect(parsed).toEqual({
    text: 'ok',
    tool_calls: [{ id: 'call_1', name: 'bash', arguments: { command: 'ls' } }],
  })
})

it('createCodeForgeCloudModel posts the real complete payload and parses the response', async () => {
  const { restore } = withCodeForgeHome()
  try {
    const seen: Array<{ url: string; body: string }> = []
    const http = jest.fn(async (url: string, init?: { body?: string }) => {
      seen.push({ url, body: String(init?.body || '') })
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => 'event: tool_call\ndata: {"id":"c2","name":"read_file","arguments":{"target_file":"a.ts"}}\n\n',
      }
    })
    const model = createCodeForgeCloudModel(http as unknown as HttpClient, {
      apiBase: 'https://www.codeforge.dev',
      token: 'jwt',
      client: 'tui',
    })
    const completion = await model.complete(request)
    expect(seen[0].url).toBe('https://www.codeforge.dev/api/runtime/complete')
    expect(seen[0].url).not.toContain('/api/chat/send')
    const payload = JSON.parse(seen[0].body)
    expect(payload.messages).toEqual(toProviderMessages(request.messages))
    expect(payload.messages[1].tool_calls[0].function.arguments).toBe(
      JSON.stringify({ target_file: 'hello.txt' }),
    )
    expect(payload.tools.length).toBe(4)
    expect(payload.task_category).toBeUndefined()
    expect(completion.tool_calls[0]).toEqual({
      id: 'c2',
      name: 'read_file',
      arguments: { target_file: 'a.ts' },
    })
  } finally {
    restore()
  }
})

it('follow-up complete after a tool result uses OpenAI function tool_calls', async () => {
  const { restore } = withCodeForgeHome()
  try {
    const seen: string[] = []
    const http = jest.fn(async (_url: string, init?: { body?: string }) => {
      seen.push(String(init?.body || ''))
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => 'event: text\ndata: "done"\n\n',
      }
    })
    const model = createCodeForgeCloudModel(http as unknown as HttpClient, {
      apiBase: 'https://www.codeforge.dev',
      token: 'jwt',
      client: 'cli',
    })
    await model.complete(request)
    const payload = JSON.parse(seen[0])
    const assistant = payload.messages[1]
    expect(assistant.role).toBe('assistant')
    expect(assistant.tool_calls[0]).toEqual({
      id: 'c1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"target_file":"hello.txt"}' },
    })
    expect(typeof assistant.tool_calls[0].function.arguments).toBe('string')
    expect(payload.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'hello codeforge' })
  } finally {
    restore()
  }
})

it('complete request headers use the explicit conversation id over session', async () => {
  const { restore } = withCodeForgeHome()
  const sessionId = '11111111-1111-1111-1111-111111111111'
  const explicitId = '22222222-2222-2222-2222-222222222222'
  try {
    writeSession({ last_conversation_id: sessionId })
    const seen: Array<{ headers: Record<string, string> }> = []
    const http = jest.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ headers: { ...(init?.headers || {}) } })
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => 'event: text\ndata: "ok"\n\n',
      }
    })
    const model = createCodeForgeCloudModel(http as unknown as HttpClient, {
      apiBase: 'https://www.codeforge.dev',
      token: 'jwt',
      client: 'cli',
      conversationId: explicitId,
    })
    await model.complete(request)
    expect(seen[0].headers['x-codeforge-conversation-id']).toBe(explicitId)
    expect(seen[0].headers['x-codeforge-conversation-id']).not.toBe(sessionId)
  } finally {
    restore()
  }
})

it('complete request headers include x-codeforge-conversation-id from session', async () => {
  const { restore } = withCodeForgeHome()
  const conversationId = '11111111-1111-1111-1111-111111111111'
  try {
    writeSession({ last_conversation_id: conversationId })
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const http = jest.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, headers: { ...(init?.headers || {}) } })
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => 'event: text\ndata: "ok"\n\n',
      }
    })
    const model = createCodeForgeCloudModel(http as unknown as HttpClient, {
      apiBase: 'https://www.codeforge.dev',
      token: 'jwt',
      client: 'cli',
    })
    await model.complete(request)
    expect(seen[0].url).toBe('https://www.codeforge.dev/api/runtime/complete')
    expect(seen[0].headers['x-codeforge-conversation-id']).toBe(conversationId)
    expect(seen[0].headers.Authorization).toBe('Bearer jwt')
    expect(readSession().last_conversation_id).toBe(conversationId)
  } finally {
    restore()
  }
})

it('402 quota_exhausted surfaces detail.message and never SuperForge', async () => {
  const http = jest.fn(async () => ({
    ok: false,
    status: 402,
    json: async () => ({
      detail: { message: '余额不足，请充值', code: 'quota_exhausted' },
    }),
    text: async () => '',
  }))
  const model = createCodeForgeCloudModel(http as unknown as HttpClient, {
    apiBase: 'https://www.codeforge.dev',
    token: 'jwt',
    client: 'tui',
  })
  let message = ''
  try {
    await model.complete(request)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message).toMatch(/余额不足，请充值/)
  expect(message).not.toMatch(/SuperForge|superforge/i)
})

it('two complete posts get distinct client_request_id values', () => {
  const a = buildCompleteRequest(request, { client: 'tui' })
  const b = buildCompleteRequest(request, { client: 'tui' })
  expect(a.client_request_id).toBeTruthy()
  expect(b.client_request_id).toBeTruthy()
  expect(a.client_request_id).not.toBe(b.client_request_id)
})
