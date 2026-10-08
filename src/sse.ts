export type SseEvent = {
  type: 'text' | 'error' | 'other'
  name: string
  data: unknown
}

function parseSseData(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function classifyEvent(name: string): SseEvent['type'] {
  if (name === 'text') return 'text'
  if (name === 'error') return 'error'
  return 'other'
}

function parseSegment(segment: string): SseEvent | null {
  if (!segment.trim()) return null
  const eventMatch = segment.match(/^event: (.+)$/m)
  const dataMatch = segment.match(/^data: (.+)$/m)
  if (!eventMatch || !dataMatch) return null
  const name = eventMatch[1].trim()
  return {
    type: classifyEvent(name),
    name,
    data: parseSseData(dataMatch[1]),
  }
}

export function consumeSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = []
  const segments = buffer.split('\n\n')
  const rest = segments.pop() ?? ''
  for (const segment of segments) {
    const event = parseSegment(segment)
    if (event) events.push(event)
  }
  return { events, rest }
}

export function sseEventText(event: SseEvent): string {
  if (event.type === 'error') {
    const message =
      typeof event.data === 'string'
        ? event.data
        : (event.data as { message?: string })?.message || 'stream error'
    throw new Error(String(message))
  }
  if (event.type !== 'text') return ''
  const data = event.data
  if (typeof data === 'string') return data
  if (data && typeof data === 'object') {
    const record = data as { text?: unknown; content?: unknown; delta?: unknown }
    const piece = record.text ?? record.content ?? record.delta
    if (typeof piece === 'string') return piece
  }
  return ''
}

export function extractSseText(stream: string): string {
  const { events } = consumeSse(stream.endsWith('\n\n') ? stream : `${stream}\n\n`)
  const chunks: string[] = []
  for (const event of events) {
    if (event.type === 'error') {
      
      sseEventText(event)
    }
    if (event.type === 'text') {
      const piece = sseEventText(event)
      if (piece) chunks.push(piece)
    }
  }
  return chunks.join('')
}
