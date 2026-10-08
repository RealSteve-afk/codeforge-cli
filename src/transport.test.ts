import { createFastApiTransport, mapSseEventToTurn } from './transport'
import { consumeSse } from './sse'
import { defaultHttp } from './http'
import { readSession, writeAuth } from './store'
import fs from 'fs'
import os from 'os'
import path from 'path'

it('maps tool_call and tool_status end to tool events and drops keepalive', () => {
  const { events } = consumeSse(
    [
      'event: keepalive\ndata: {}\n\n',
      'event: tool_call\ndata: {"tool":"read_file","round":1,"input":{"path":"a.ts"}}\n\n',
      'event: tool_status\ndata: {"event":"end","tool":"read_file","round":1,"success":true,"result":"ok"}\n\n',
    ].join(''),
  )
  expect(events.map((event) => mapSseEventToTurn(event))).toEqual([
    null,
    { type: 'tool', text: expect.stringContaining('read_file') },
    { type: 'tool', text: expect.stringMatching(/read_file[\s\S]*ok/) },
  ])
})

it('ignores unsupported tool_status phases', () => {
  const { events } = consumeSse(
    'event: tool_status\ndata: {"event":"progress","tool":"read_file"}\n\n' +
      'event: tool_status\ndata: {"event":"round","tool":"read_file"}\n\n',
  )
  expect(events.map((event) => mapSseEventToTurn(event))).toEqual([null, null])
})

it('bounds create_file input and reads result_preview on end', () => {
  const body = 'x'.repeat(400)
  const { events } = consumeSse(
    [
      `event: tool_call\ndata: ${JSON.stringify({ tool: 'create_file', input: { path: 'big.ts', body } })}\n\n`,
      'event: tool_status\ndata: {"event":"end","tool":"create_file","success":true,"result_preview":"wrote 12 lines"}\n\n',
    ].join(''),
  )
  const mapped = events.map((event) => mapSseEventToTurn(event))
  expect(mapped[0]?.text).toContain('create_file')
  expect(mapped[0]?.text).toContain('path=big.ts')
  expect(mapped[0]?.text).not.toContain(body)
  expect(mapped[1]).toEqual({ type: 'tool', text: 'create_file · end · ok · wrote 12 lines' })
})

it('binds and persists the conversation id as soon as create returns', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-tr-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  writeAuth({ token: 't', email: 'a@b.c', user_id: 'u', api_base: 'https://www.codeforge.dev' })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const http = jest.fn()
    .mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'conv-x' }),
      text: async () => '',
    })
    .mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({}),
      text: async () => '',
      async *stream() {
        await held
        yield 'event: text\ndata: "ab"\n\n'
      },
    })
  try {
    const transport = createFastApiTransport(http)
    const gen = transport.send('hello', { newConversation: true })
    const first = await gen.next()
    expect(first.done).toBe(false)
    expect(first.value).toEqual({ type: 'bound', text: 'conv-x' })
    expect(readSession().last_conversation_id).toBe('conv-x')
    release()
    let next = await gen.next()
    while (!next.done) next = await gen.next()
    expect(next.value.conversationId).toBe('conv-x')
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('streams text events and records the conversation id', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-tr-'))
  process.env.CODEFORGE_HOME = home
  writeAuth({ token: 't', email: 'a@b.c', user_id: 'u', api_base: 'https://www.codeforge.dev' })
  const http = jest.fn()
    .mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'conv-x' }),
      text: async () => '',
    })
    .mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({}),
      text: async () => '',
      async *stream() {
        yield 'event: text\ndata: "ab"\n\n'
        yield 'event: text\ndata: "c"\n\n'
      },
    })
  const transport = createFastApiTransport(http)
  const pieces: string[] = []
  const gen = transport.send('hello', { newConversation: true })
  let next = await gen.next()
  while (!next.done) {
    if (next.value.type === 'text' && next.value.text) pieces.push(next.value.text)
    next = await gen.next()
  }
  expect(pieces.join('')).toBe('abc')
  expect(next.value.conversationId).toBe('conv-x')
  const createBody = JSON.parse(String(http.mock.calls[0][1]?.body))
  expect(createBody.client).toBe('tui')
  fs.rmSync(home, { recursive: true, force: true })
})

it('falls back to text() and yields error events without throwing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-tr-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  writeAuth({ token: 't', email: 'a@b.c', user_id: 'u', api_base: 'https://www.codeforge.dev' })
  const http = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => 'event: text\ndata: "ok"\n\nevent: error\ndata: {"message":"quota"}\n\n',
  })
  try {
    const events: Array<{ type: string; text?: string }> = []
    const gen = createFastApiTransport(http).send('resume', { conversationId: 'conv-y' })
    let next = await gen.next()
    while (!next.done) {
      events.push(next.value)
      next = await gen.next()
    }
    expect(events).toEqual([
      { type: 'bound', text: 'conv-y' },
      { type: 'text', text: 'ok' },
      { type: 'error', text: 'quota' },
    ])
    expect(next.value.conversationId).toBe('conv-y')
    expect(http).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(http.mock.calls[0][1]?.body))).toMatchObject({
      conversation_id: 'conv-y',
      client: 'tui',
      task_category: 'coding',
    })
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('loads a conversation transcript from GET /conversations/:id', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-tr-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  writeAuth({ token: 't', email: 'a@b.c', user_id: 'u', api_base: 'https://www.codeforge.dev' })
  const http = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      id: 'conv-9',
      title: 'prior',
      messages: [
        { id: 'm1', role: 'user', content: 'hello' },
        { id: 'm2', role: 'assistant', content: 'hi', content_blocks: [{ type: 'tool_use', name: 'ls' }] },
      ],
    }),
    text: async () => '',
  })
  try {
    const row = await createFastApiTransport(http).getConversation('conv-9')
    expect(row).toEqual({
      id: 'conv-9',
      title: 'prior',
      messages: [
        { id: 'm1', role: 'user', content: 'hello' },
        { id: 'm2', role: 'assistant', content: 'hi', content_blocks: [{ type: 'tool_use', name: 'ls' }] },
      ],
    })
    expect(http).toHaveBeenCalledWith(
      'https://www.codeforge.dev/api/chat/conversations/conv-9',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer t' }) }),
    )
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('lists cloud conversations for resume', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-tr-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  writeAuth({ token: 't', email: 'a@b.c', user_id: 'u', api_base: 'https://www.codeforge.dev' })
  const http = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => [{ id: 'conv-9', title: 'prior', client: 'tui' }],
    text: async () => '',
  })
  try {
    const rows = await createFastApiTransport(http).listConversations()
    expect(rows).toEqual([{ id: 'conv-9', title: 'prior', client: 'tui' }])
    expect(http).toHaveBeenCalledWith(
      'https://www.codeforge.dev/api/chat/conversations?limit=30',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer t' }) }),
    )
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

describe('defaultHttp.stream', () => {
  const previousFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = previousFetch
  })

  it('decodes response.body chunks', async () => {
    const chunks = [new TextEncoder().encode('hel'), new TextEncoder().encode('lo')]
    let index = 0
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => 'unused',
      body: {
        getReader() {
          return {
            async read() {
              if (index >= chunks.length) return { done: true, value: undefined }
              const value = chunks[index]
              index += 1
              return { done: false, value }
            },
            releaseLock() {},
          }
        },
      },
    }) as typeof fetch

    const response = await defaultHttp('https://www.codeforge.dev/api/chat/send')
    const pieces: string[] = []
    for await (const chunk of response.stream!()) pieces.push(chunk)
    expect(pieces.join('')).toBe('hello')
  })

  it('yields text() once when body is missing', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => 'buffered',
      body: null,
    }) as typeof fetch

    const response = await defaultHttp('https://www.codeforge.dev/api/chat/send')
    const pieces: string[] = []
    for await (const chunk of response.stream!()) pieces.push(chunk)
    expect(pieces).toEqual(['buffered'])
  })
})
