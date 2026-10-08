export interface HttpResponse {
  ok: boolean
  status: number
  json(): Promise<any>
  text(): Promise<string>
  stream?(): AsyncIterable<string>
}

export type HttpClient = (url: string, init?: RequestInit) => Promise<HttpResponse>

export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

async function* streamResponse(response: Response): AsyncIterable<string> {
  const body = response.body
  if (!body) {
    yield await response.text()
    return
  }
  const decoder = new TextDecoder()
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) yield decoder.decode(value, { stream: true })
    }
    const tail = decoder.decode()
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

export async function defaultHttp(url: string, init?: RequestInit): Promise<HttpResponse> {
  const response = await fetch(url, init)
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
    text: () => response.text(),
    stream: () => streamResponse(response),
  }
}

export function errorDetail(body: any, fallback: string): string {
  if (typeof body?.detail === 'string') return body.detail
  
  if (body?.detail && typeof body.detail === 'object') {
    if (typeof body.detail.message === 'string' && body.detail.message.trim()) {
      return body.detail.message
    }
  }
  if (typeof body?.error === 'string') return body.error
  if (typeof body?.message === 'string') return body.message
  return fallback
}
