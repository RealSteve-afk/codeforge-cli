import fs from 'fs'
import path from 'path'
import { authHeaders, type HttpClient } from '../http'

export type TranscriptEventKind = 'compaction' | 'tool_result_full'

export type TranscriptEvent = {
  kind: TranscriptEventKind
  conversation_id?: string
  client_request_id?: string
  product_id?: string
  messages?: unknown[]
  payload?: Record<string, unknown>
}

export function transcriptEventFromCheckpoint(
  raw: string,
  conversationId: string,
  fallbackId?: string,
): TranscriptEvent | null {
  let parsed: { compacted_history?: unknown; checkpoint_id?: unknown; schema_version?: unknown; prompt_index_at_compaction?: unknown }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return null
  }
  if (!Array.isArray(parsed.compacted_history)) return null
  const checkpointId = String(parsed.checkpoint_id || '').trim() || String(fallbackId || '').trim()
  if (!checkpointId) return null
  return {
    kind: 'compaction',
    conversation_id: conversationId,
    client_request_id: checkpointId,
    messages: parsed.compacted_history,
    payload: {
      checkpoint_id: checkpointId,
      schema_version: parsed.schema_version,
      prompt_index_at_compaction: parsed.prompt_index_at_compaction,
    },
  }
}

export function transcriptEventFromToolLog(
  content: string,
  conversationId: string,
  toolCallId: string,
): TranscriptEvent {
  return {
    kind: 'tool_result_full',
    conversation_id: conversationId,
    client_request_id: toolCallId,
    payload: { tool_call_id: toolCallId, content },
  }
}

export function listCompactionCheckpointFiles(engineHome: string): string[] {
  const sessions = path.join(engineHome, 'sessions')
  if (!fs.existsSync(sessions)) return []
  const out: string[] = []
  for (const sessionName of fs.readdirSync(sessions)) {
    const dir = path.join(sessions, sessionName, 'compaction_checkpoints')
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.json')) out.push(path.join(dir, name))
    }
  }
  return out.sort()
}

export function rememberExistingCheckpoints(engineHome: string, posted: Set<string>): void {
  for (const file of listCompactionCheckpointFiles(engineHome)) posted.add(file)
}

export function listTerminalLogFiles(engineHome: string): string[] {
  const sessions = path.join(engineHome, 'sessions')
  if (!fs.existsSync(sessions)) return []
  const out: string[] = []
  for (const sessionName of fs.readdirSync(sessions)) {
    const dir = path.join(sessions, sessionName, 'terminal')
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.log')) out.push(path.join(dir, name))
    }
  }
  return out.sort()
}

export function rememberExistingTerminalLogs(engineHome: string, posted: Set<string>): void {
  for (const file of listTerminalLogFiles(engineHome)) posted.add(file)
}

const TOOL_LOG_MAX_BYTES = 8 * 1024 * 1024

function readToolLog(file: string): string {
  const size = fs.statSync(file).size
  if (size <= 0) return ''
  if (size <= TOOL_LOG_MAX_BYTES) return fs.readFileSync(file, 'utf8')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(TOOL_LOG_MAX_BYTES)
    fs.readSync(fd, buf, 0, TOOL_LOG_MAX_BYTES, 0)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

export async function flushNewTerminalLogs(options: {
  engineHome: string
  conversationId: string
  posted: Set<string>
  post: (event: TranscriptEvent) => Promise<boolean>
}): Promise<number> {
  let sent = 0
  for (const file of listTerminalLogFiles(options.engineHome)) {
    if (options.posted.has(file)) continue
    let content = ''
    try {
      content = readToolLog(file)
    } catch {
      continue
    }
    if (!content) continue
    const event = transcriptEventFromToolLog(content, options.conversationId, path.parse(file).name)
    const ok = await options.post(event)
    if (!ok) continue
    options.posted.add(file)
    sent += 1
  }
  return sent
}

export async function postTranscriptEvent(
  http: HttpClient,
  apiBase: string,
  token: string,
  event: TranscriptEvent,
): Promise<boolean> {
  const base = apiBase.replace(/\/+$/, '')
  const headers: Record<string, string> = { ...authHeaders(token) }
  if (event.conversation_id) headers['x-codeforge-conversation-id'] = event.conversation_id
  const response = await http(`${base}/api/runtime/v1/transcript/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify(event),
  })
  return Boolean(response?.ok)
}

export async function flushNewCompactionCheckpoints(options: {
  engineHome: string
  conversationId: string
  posted: Set<string>
  post: (event: TranscriptEvent) => Promise<boolean>
}): Promise<number> {
  let sent = 0
  for (const file of listCompactionCheckpointFiles(options.engineHome)) {
    if (options.posted.has(file)) continue
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const event = transcriptEventFromCheckpoint(raw, options.conversationId, path.parse(file).name)
    if (!event) continue
    const ok = await options.post(event)
    if (!ok) continue
    options.posted.add(file)
    sent += 1
  }
  return sent
}

export function startTranscriptWatch(options: {
  engineHome: string
  conversationId: string
  post: (event: TranscriptEvent) => Promise<boolean>
  intervalMs?: number
}): () => Promise<void> {
  const posted = new Set<string>()
  rememberExistingCheckpoints(options.engineHome, posted)
  rememberExistingTerminalLogs(options.engineHome, posted)
  const tick = () =>
    Promise.all([
      flushNewCompactionCheckpoints({
        engineHome: options.engineHome,
        conversationId: options.conversationId,
        posted,
        post: options.post,
      }),
      flushNewTerminalLogs({
        engineHome: options.engineHome,
        conversationId: options.conversationId,
        posted,
        post: options.post,
      }),
    ]).catch(() => 0)
  const timer = setInterval(() => {
    void tick()
  }, options.intervalMs ?? 2000)
  void tick()
  return async () => {
    clearInterval(timer)
    await tick()
  }
}

export const startCompactionCheckpointWatch = startTranscriptWatch
