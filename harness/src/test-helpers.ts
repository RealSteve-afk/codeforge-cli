import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { Store } from './core/store'

export function tempDir(prefix = 'harness-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function tempStore(): Store {
  return new Store(tempDir())
}

export interface Recorded {
  path: string
  body: any
  headers: http.IncomingHttpHeaders
}

// A local HTTP server that answers each POST with the next scripted list of SSE frames.
export async function fakeSseServer(script: string[][]): Promise<{ url: string; requests: Recorded[]; close: () => void }> {
  const requests: Recorded[] = []
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    requests.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), headers: req.headers })
    const frames = script[requests.length - 1]
    if (!frames) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'api_error', message: 'no more scripted responses' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const frame of frames) res.write(frame)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, requests, close: () => server.close() }
}

function sse(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

// Anthropic Messages API stream frames.
export const anthropicSse = {
  start: (id = 'msg_1') =>
    sse('message_start', {
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
  text: (index: number, text: string) => [
    sse('content_block_start', { index, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { index }),
  ],
  toolUse: (index: number, id: string, name: string, input: object) => [
    sse('content_block_start', { index, content_block: { type: 'tool_use', id, name, input: {} } }),
    sse('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
    sse('content_block_stop', { index }),
  ],
  progress: (index: number, text: string) => [
    sse('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    sse('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: text } }),
    sse('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'sig' } }),
    sse('content_block_stop', { index }),
  ],
  webSearch: (index: number, id: string, query: string, results: Array<{ title: string; url: string }>) => [
    sse('content_block_start', { index, content_block: { type: 'server_tool_use', id, name: 'web_search', input: {} } }),
    sse('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } }),
    sse('content_block_stop', { index }),
    sse('content_block_start', {
      index: index + 1,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: id,
        content: results.map((r) => ({ type: 'web_search_result', title: r.title, url: r.url, encrypted_content: 'enc', page_age: null })),
      },
    }),
    sse('content_block_stop', { index: index + 1 }),
  ],
  end: (stopReason: string) => [
    sse('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }),
    sse('message_stop', {}),
  ],
}

// OpenAI Chat Completions stream frames.
export const openaiSse = {
  chunk: (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
  usage: () =>
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`,
  done: () => 'data: [DONE]\n\n',
}
