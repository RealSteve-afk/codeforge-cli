import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  flushNewCompactionCheckpoints,
  listCompactionCheckpointFiles,
  postTranscriptEvent,
  rememberExistingCheckpoints,
  rememberExistingTerminalLogs,
  flushNewTerminalLogs,
  transcriptEventFromCheckpoint,
  transcriptEventFromToolLog,
} from './transcriptEvents'

function makeEngine(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-engine-'))
}

it('parses forge compaction checkpoint compacted_history', () => {
  const event = transcriptEventFromCheckpoint(
    JSON.stringify({
      checkpoint_id: 'cp-9',
      prompt_index_at_compaction: 4,
      schema_version: 1,
      compacted_history: [{ role: 'user', content: 'summary of foo.py' }],
    }),
    '11111111-1111-1111-1111-111111111111',
  )
  expect(event?.kind).toBe('compaction')
  expect(event?.client_request_id).toBe('cp-9')
  expect(event?.messages).toEqual([{ role: 'user', content: 'summary of foo.py' }])
  expect(event?.payload?.checkpoint_id).toBe('cp-9')
})

it('ignores checkpoint files without compacted_history', () => {
  expect(transcriptEventFromCheckpoint('{"checkpoint_id":"x"}', 'c1')).toBeNull()
  expect(transcriptEventFromCheckpoint('not-json', 'c1')).toBeNull()
})

it('lists only compaction_checkpoints json under sessions', () => {
  const engine = makeEngine()
  try {
    const dir = path.join(engine, 'sessions', 'sess-1', 'compaction_checkpoints')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.json'), '{}')
    fs.writeFileSync(path.join(engine, 'sessions', 'sess-1', 'updates.jsonl'), 'nope')
    expect(listCompactionCheckpointFiles(engine)).toEqual([path.join(dir, 'a.json')])
  } finally {
    fs.rmSync(engine, { recursive: true, force: true })
  }
})

it('flushes a new checkpoint once and posts compaction event', async () => {
  const engine = makeEngine()
  const posted: unknown[] = []
  const seen = new Set<string>()
  try {
    const dir = path.join(engine, 'sessions', 'sess-1', 'compaction_checkpoints')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'cp.json'),
      JSON.stringify({
        checkpoint_id: 'cp-1',
        compacted_history: [{ role: 'user', content: 'window' }],
      }),
    )
    const first = await flushNewCompactionCheckpoints({
      engineHome: engine,
      conversationId: 'conv-1',
      posted: seen,
      post: async (event) => {
        posted.push(event)
        return true
      },
    })
    const second = await flushNewCompactionCheckpoints({
      engineHome: engine,
      conversationId: 'conv-1',
      posted: seen,
      post: async (event) => {
        posted.push(event)
        return true
      },
    })
    expect(first).toBe(1)
    expect(second).toBe(0)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ kind: 'compaction', client_request_id: 'cp-1' })
  } finally {
    fs.rmSync(engine, { recursive: true, force: true })
  }
})

it('posts transcript events to runtime with conversation header', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const http = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' }
  }
  const ok = await postTranscriptEvent(http, 'https://www.codeforge.dev/', 'jwt', {
    kind: 'compaction',
    conversation_id: 'conv-9',
    messages: [{ role: 'user', content: 'w' }],
  })
  expect(ok).toBe(true)
  expect(calls[0].url).toBe('https://www.codeforge.dev/api/runtime/v1/transcript/events')
  expect((calls[0].init?.headers as Record<string, string>)['x-codeforge-conversation-id']).toBe('conv-9')
  expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt')
  expect(JSON.parse(String(calls[0].init?.body)).kind).toBe('compaction')
})

it('builds tool_result_full events from local log content', () => {
  const event = transcriptEventFromToolLog('full shell output', 'conv-1', 'call-1')
  expect(event.kind).toBe('tool_result_full')
  expect(event.payload).toEqual({ tool_call_id: 'call-1', content: 'full shell output' })
})

it('does not post checkpoints that existed before the watch seeded posted', async () => {
  const engine = makeEngine()
  const postedEvents: unknown[] = []
  try {
    const oldDir = path.join(engine, 'sessions', 'old-sess', 'compaction_checkpoints')
    const liveDir = path.join(engine, 'sessions', 'live-sess', 'compaction_checkpoints')
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(liveDir, { recursive: true })
    fs.writeFileSync(
      path.join(oldDir, 'old.json'),
      JSON.stringify({
        checkpoint_id: 'old-cp',
        compacted_history: [{ role: 'user', content: 'from other session' }],
      }),
    )
    const seen = new Set<string>()
    rememberExistingCheckpoints(engine, seen)
    fs.writeFileSync(
      path.join(liveDir, 'new.json'),
      JSON.stringify({
        checkpoint_id: 'new-cp',
        compacted_history: [{ role: 'user', content: 'this conversation' }],
      }),
    )
    const sent = await flushNewCompactionCheckpoints({
      engineHome: engine,
      conversationId: 'conv-live',
      posted: seen,
      post: async (event) => {
        postedEvents.push(event)
        return true
      },
    })
    expect(sent).toBe(1)
    expect(postedEvents).toHaveLength(1)
    expect(postedEvents[0]).toMatchObject({
      kind: 'compaction',
      client_request_id: 'new-cp',
      conversation_id: 'conv-live',
    })
    expect(JSON.stringify(postedEvents)).not.toContain('from other session')
  } finally {
    fs.rmSync(engine, { recursive: true, force: true })
  }
})

it('uses checkpoint filename when checkpoint_id is missing', () => {
  const event = transcriptEventFromCheckpoint(
    JSON.stringify({ compacted_history: [{ role: 'user', content: 'w' }] }),
    'conv-1',
    'file-uuid',
  )
  expect(event?.client_request_id).toBe('file-uuid')
})

it('posts only new terminal logs from this pager run as tool_result_full', async () => {
  const engine = makeEngine()
  const postedEvents: unknown[] = []
  try {
    const oldDir = path.join(engine, 'sessions', 'old-sess', 'terminal')
    const liveDir = path.join(engine, 'sessions', 'live-sess', 'terminal')
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(liveDir, { recursive: true })
    fs.writeFileSync(path.join(oldDir, 'call-old.log'), 'old shell output')
    const seen = new Set<string>()
    rememberExistingCheckpoints(engine, seen)
    rememberExistingTerminalLogs(engine, seen)
    fs.writeFileSync(path.join(liveDir, 'call-new.log'), 'full shell output')
    const sent = await flushNewTerminalLogs({
      engineHome: engine,
      conversationId: 'conv-live',
      posted: seen,
      post: async (event) => {
        postedEvents.push(event)
        return true
      },
    })
    expect(sent).toBe(1)
    expect(postedEvents).toHaveLength(1)
    expect(postedEvents[0]).toMatchObject({
      kind: 'tool_result_full',
      client_request_id: 'call-new',
      conversation_id: 'conv-live',
      payload: { tool_call_id: 'call-new', content: 'full shell output' },
    })
    expect(JSON.stringify(postedEvents)).not.toContain('old shell output')
  } finally {
    fs.rmSync(engine, { recursive: true, force: true })
  }
})
