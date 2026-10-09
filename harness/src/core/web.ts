import dns from 'dns'
import http from 'http'
import https from 'https'
import net from 'net'

export type SearchProvider = 'none' | 'brave' | 'searxng'

export interface SearchConfig {
  provider: SearchProvider
  baseUrl?: string
  apiKey?: string
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export class WebError extends Error {}

const MAX_PAGE_BYTES = 2_000_000
const MAX_PAGE_CHARS = 20_000
const TIMEOUT_MS = 20_000

// Search backends for providers without built-in web search (OpenAI-compatible profiles).
export async function searchWeb(config: SearchConfig, query: string, count = 8): Promise<SearchResult[]> {
  if (config.provider === 'brave') {
    if (!config.apiKey) throw new WebError('Brave Search needs an API key (Settings → Web search)')
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`
    const res = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': config.apiKey }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new WebError(`Brave Search returned HTTP ${res.status}`)
    const body = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
    return (body.web?.results ?? []).slice(0, count).map((r) => ({ title: clean(r.title ?? ''), url: r.url ?? '', snippet: clean(r.description ?? '') }))
  }
  if (config.provider === 'searxng') {
    if (!config.baseUrl) throw new WebError('SearXNG needs a base URL (Settings → Web search)')
    const url = `${config.baseUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new WebError(`SearXNG returned HTTP ${res.status} (is the JSON format enabled?)`)
    const body = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> }
    return (body.results ?? []).slice(0, count).map((r) => ({ title: clean(r.title ?? ''), url: r.url ?? '', snippet: clean(r.content ?? '') }))
  }
  throw new WebError('web search is not configured; an admin can set it up in Settings → Web search')
}

// ---- page fetching with SSRF protection --------------------------------------

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    )
  }
  const lower = address.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateAddress(mapped[1])
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff')
}

// DNS lookup that refuses private addresses. Used as the socket's lookup, so the
// checked address is the one actually connected to (no DNS-rebinding gap).
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '', 4)
    const list = addresses as dns.LookupAddress[]
    const bad = list.find((a) => isPrivateAddress(a.address))
    if (bad || !list.length) return callback(new WebError(`refusing to fetch ${hostname}: it resolves to a private network address`), '', 4)
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

export interface FetchedPage {
  url: string
  status: number
  contentType: string
  title: string
  text: string
}

export async function fetchPage(rawUrl: string, options: { allowPrivate?: boolean; signal?: AbortSignal } = {}): Promise<FetchedPage> {
  let url = new URL(rawUrl)
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebError('only http and https URLs can be fetched')
    if (!options.allowPrivate && net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
      throw new WebError(`refusing to fetch ${url.hostname}: private network address`)
    }
    const res = await request(url, options)
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = new URL(res.location, url)
      continue
    }
    if (res.status >= 400) throw new WebError(`HTTP ${res.status} from ${url.href}`)
    const isHtml = /html/i.test(res.contentType)
    if (!isHtml && !/^text\/|json|xml|javascript/i.test(res.contentType)) {
      throw new WebError(`unsupported content type ${res.contentType || 'unknown'}`)
    }
    const raw = res.body.toString('utf8')
    const title = isHtml ? decodeEntities(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim() : ''
    const text = isHtml ? htmlToText(raw) : raw
    return {
      url: url.href,
      status: res.status,
      contentType: res.contentType,
      title,
      text: text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n… [truncated]` : text,
    }
  }
  throw new WebError('too many redirects')
}

function request(url: URL, options: { allowPrivate?: boolean; signal?: AbortSignal }): Promise<{ status: number; contentType: string; location?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.get(
      url,
      {
        headers: { 'User-Agent': 'ForgeHarness/0.1 (+https://github.com/)', Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
        timeout: TIMEOUT_MS,
        signal: options.signal,
        ...(options.allowPrivate ? {} : { lookup: guardedLookup }),
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_PAGE_BYTES) {
            req.destroy()
            resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) })
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            location: typeof res.headers.location === 'string' ? res.headers.location : undefined,
            body: Buffer.concat(chunks),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new WebError('request timed out')))
    req.on('error', reject)
  })
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' }
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n < 0x110000 ? String.fromCodePoint(n) : match
    }
    return named[code.toLowerCase()] ?? match
  })
}

function clean(text: string): string {
  return htmlToText(text).replace(/\s+/g, ' ').trim()
}

// URLs found in text, normalized for comparison (used to restrict web_fetch to
// URLs the user or a search actually surfaced, which limits data exfiltration).
export function extractUrls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []).map(normalizeUrl).filter((u): u is string => Boolean(u))
}

export function normalizeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.replace(/[.,;:!?]+$/, ''))
    url.hash = ''
    return url.href.replace(/\/$/, '')
  } catch {
    return undefined
  }
}
