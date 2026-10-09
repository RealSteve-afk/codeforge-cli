import assert from 'node:assert/strict'
import { test } from 'node:test'
import Anthropic from '@anthropic-ai/sdk'
import { anthropicSse, fakeSseServer, openaiSse } from '../../test-helpers'
import { TOOLS } from '../tools'
import { anthropicProvider } from './anthropic'
import { openaiProvider } from './openai'
import type { AgentEvent, ToolCall, TurnContext } from './types'

function context(history: unknown[], events: AgentEvent[], calls: ToolCall[]): TurnContext & { commits: number } {
  const ctx = {
    history,
    commits: 0,
    commit() {
      ctx.commits += 1
    },
    system: 'system prompt',
    tools: TOOLS,
    async runTools(toolCalls: ToolCall[]) {
      calls.push(...toolCalls)
      return toolCalls.map((c) => ({ id: c.id, output: `result for ${c.name}`, isError: false }))
    },
    emit: (event: AgentEvent) => events.push(event),
    signal: new AbortController().signal,
  }
  return ctx
}

test('anthropic provider streams, runs tools and sends results back with the SDK', async () => {
  const fake = await fakeSseServer([
    [anthropicSse.start('msg_1'), ...anthropicSse.toolUse(0, 'toolu_1', 'read_file', { path: 'a.txt' }), ...anthropicSse.end('tool_use')],
    [anthropicSse.start('msg_2'), ...anthropicSse.text(0, 'All done.'), ...anthropicSse.end('end_turn')],
  ])
  try {
    const provider = anthropicProvider({ apiKey: 'sk-test', model: 'claude-opus-5-5', baseUrl: fake.url, effort: 'high', thinking: true, fallbacks: true })
    const history: unknown[] = []
    const events: AgentEvent[] = []
    const calls: ToolCall[] = []
    const ctx = context(history, events, calls)
    const stop = await provider.runTurn('read a.txt', ctx)

    assert.equal(stop, 'end_turn')
    assert.deepEqual(calls, [{ id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } }])
    assert.ok(events.some((e) => e.type === 'text' && e.text === 'All done.'))
    assert.equal(ctx.commits, 2)
    assert.equal(history.length, 4)

    const first = fake.requests[0].body
    assert.equal(first.model, 'claude-opus-5-5')
    assert.deepEqual(first.thinking, { type: 'adaptive', display: 'summarized' })
    assert.deepEqual(first.output_config, { effort: 'high' })
    assert.equal(first.tools[0].eager_input_streaming, true)
    assert.equal(first.tools[0].input_schema.type, 'object')
    // A custom base URL is not the Claude API, so no server-side fallback is requested.
    assert.equal(first.fallbacks, undefined)
    assert.equal(fake.requests[0].headers['x-api-key'], 'sk-test')

    const second = fake.requests[1].body
    const last = second.messages[second.messages.length - 1]
    assert.equal(last.role, 'user')
    assert.deepEqual(last.content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result for read_file' }])
  } finally {
    fake.close()
  }
})

test('anthropic provider never runs a tool call cut off by max_tokens', async () => {
  const fake = await fakeSseServer([[anthropicSse.start(), ...anthropicSse.toolUse(0, 'toolu_1', 'write_file', { path: 'a' }), ...anthropicSse.end('max_tokens')]])
  try {
    const provider = anthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', baseUrl: fake.url, thinking: false, fallbacks: false })
    const calls: ToolCall[] = []
    const ctx = context([], [], calls)
    assert.equal(await provider.runTurn('go', ctx), 'max_tokens')
    assert.equal(calls.length, 0)
    assert.equal(ctx.commits, 0)
  } finally {
    fake.close()
  }
})

test('anthropic provider requests the server-side refusal fallback on the Claude API', async () => {
  const fake = await fakeSseServer([[anthropicSse.start(), ...anthropicSse.text(0, 'hi'), ...anthropicSse.end('end_turn')]])
  try {
    // No baseUrl in the options means "the Claude API"; the injected client only redirects the transport.
    const client = new Anthropic({ apiKey: 'k', baseURL: fake.url })
    const provider = anthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', thinking: true, fallbacks: true }, client)
    await provider.runTurn('hello', context([], [], []))
    assert.equal(fake.requests[0].body.fallbacks, 'default')
    assert.match(String(fake.requests[0].headers['anthropic-beta']), /server-side-fallback-2026-07-01/)
  } finally {
    fake.close()
  }
})

test('openai-compatible provider accumulates streamed tool calls', async () => {
  const fake = await fakeSseServer([
    [
      openaiSse.chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: '{"pa' } }] }),
      openaiSse.chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"."}' } }] }, 'tool_calls'),
      openaiSse.usage(),
      openaiSse.done(),
    ],
    [openaiSse.chunk({ role: 'assistant', content: 'Here you go' }, 'stop'), openaiSse.done()],
  ])
  try {
    const provider = openaiProvider({ model: 'qwen3', baseUrl: `${fake.url}/v1` })
    const history: unknown[] = []
    const events: AgentEvent[] = []
    const calls: ToolCall[] = []
    const stop = await provider.runTurn('list files', context(history, events, calls))
    assert.equal(stop, 'stop')
    assert.deepEqual(calls, [{ id: 'call_1', name: 'list_dir', input: { path: '.' } }])
    assert.ok(events.some((e) => e.type === 'usage' && e.inputTokens === 7))
    const second = fake.requests[1].body
    assert.equal(second.messages[0].role, 'system')
    assert.deepEqual(second.messages[second.messages.length - 1], { role: 'tool', tool_call_id: 'call_1', content: 'result for list_dir' })
  } finally {
    fake.close()
  }
})
