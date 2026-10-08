export const TOOL_STATUS_PHASES = new Set(['start', 'executing', 'end'])
export const TOOL_DETAIL_CAP = 160

export function boundToolText(value: string, cap = TOOL_DETAIL_CAP): string {
  const one = value.replace(/\s+/g, ' ').trim()
  if (!one) return ''
  if (one.length <= cap) return one
  return `${one.slice(0, Math.max(1, cap - 1))}…`
}

export function summarizeToolInput(input: unknown): string {
  if (typeof input === 'string') return boundToolText(input)
  if (!input || typeof input !== 'object') return ''
  const rec = input as Record<string, unknown>
  for (const key of ['path', 'file', 'query', 'url', 'name']) {
    if (typeof rec[key] === 'string' && rec[key].trim()) {
      return boundToolText(`${key}=${rec[key]}`)
    }
  }
  const keys = Object.keys(rec)
  if (keys.length === 1 && typeof rec[keys[0]] === 'string') {
    return boundToolText(`${keys[0]}=${rec[keys[0]]}`)
  }
  return boundToolText(keys.join(','))
}

function toolName(data: Record<string, unknown>): string {
  return String(data.tool || data.name || data.type || 'tool')
}

function startDetail(data: Record<string, unknown>): string {
  if (typeof data.description === 'string' && data.description.trim()) {
    return boundToolText(data.description)
  }
  if (typeof data.text === 'string' && data.text.trim()) return boundToolText(data.text)
  if (typeof data.content === 'string' && data.content.trim()) return boundToolText(data.content)
  if (data.content && typeof data.content === 'object') return summarizeToolInput(data.content)
  if (data.input !== undefined) return summarizeToolInput(data.input)
  return ''
}

function endDetail(data: Record<string, unknown>): string {
  const ok = data.success === false ? 'fail' : data.success === true ? 'ok' : ''
  const preview =
    typeof data.result_preview === 'string'
      ? data.result_preview
      : typeof data.result_summary === 'string'
        ? data.result_summary
        : typeof data.result === 'string'
          ? data.result
          : ''
  const bits = [ok, preview ? boundToolText(preview) : ''].filter(Boolean)
  return bits.join(' · ')
}


export function summarizeLiveTool(data: Record<string, unknown>, eventName: string): string | null {
  const tool = toolName(data)
  if (eventName === 'tool_status') {
    const phase = String(data.event || '')
    if (!TOOL_STATUS_PHASES.has(phase)) return null
    if (phase === 'end') {
      const detail = endDetail(data)
      return detail ? `${tool} · end · ${detail}` : `${tool} · end`
    }
    const detail = startDetail(data)
    return detail ? `${tool} · ${phase} · ${detail}` : `${tool} · ${phase}`
  }
  if (eventName === 'tool_call') {
    const detail = startDetail(data)
    return detail ? `${tool} · call · ${detail}` : `${tool} · call`
  }
  return null
}


export function summarizePersistedTool(block: Record<string, unknown>): string {
  const tool = toolName(block)
  const type = String(block.type || '')
  if (type === 'tool_end' || type === 'tool_result') {
    const detail = endDetail(block)
    if (detail) return `${tool} · ${detail}`
  }
  const detail = startDetail(block)
  return detail ? `${tool} · ${detail}` : tool
}
