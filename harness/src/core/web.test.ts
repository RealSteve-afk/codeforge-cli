import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { extractUrls, fetchPage, htmlToText, isPrivateAddress, searchWeb } from './web'

test('private and special addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip)
})

test('fetchPage refuses localhost and private hosts', async () => {
  await assert.rejects(fetchPage('http://127.0.0.1:9/'), /private network/)
  await assert.rejects(fetchPage('http://localhost:9/'), /private network/)
  await assert.rejects(fetchPage('file:///etc/passwd'), /only http and https/)
})

test('fetchPage extracts readable text', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html><head><title>Hi &amp; bye</title><style>x{}</style></head><body><nav>menu</nav><p>Hello <b>world</b></p><script>evil()</script></body></html>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const page = await fetchPage(`http://127.0.0.1:${(server.address() as { port: number }).port}/`, { allowPrivate: true })
    assert.equal(page.title, 'Hi & bye')
    assert.equal(page.text, 'Hello world')
  } finally {
    server.close()
  }
})

test('SearXNG search backend', async () => {
  const server = http.createServer((req, res) => {
    assert.match(req.url ?? '', /q=rust%20async&format=json/)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ results: [{ title: 'Async Rust', url: 'https://rust-lang.github.io/async-book/', content: 'The <b>book</b>' }] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const results = await searchWeb({ provider: 'searxng', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, 'rust async')
    assert.deepEqual(results, [{ title: 'Async Rust', url: 'https://rust-lang.github.io/async-book/', snippet: 'The book' }])
  } finally {
    server.close()
  }
  await assert.rejects(searchWeb({ provider: 'none' }, 'x'), /not configured/)
})

test('helpers', () => {
  assert.equal(htmlToText('<ul><li>a</li><li>b</li></ul>'), '- a\n- b')
  assert.deepEqual(extractUrls('see https://example.com/a/, and (https://x.org/b#frag).'), ['https://example.com/a', 'https://x.org/b'])
})
