import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { ApiError, HarnessClient } from '../client/api'
import { Agent } from '../core/agent'
import type { AgentEvent, Provider } from '../core/providers/types'
import type { Store } from '../core/store'
import { tempStore } from '../test-helpers'
import { createServer, listen } from './server'

// A scripted provider: asks to write a file, then answers with text.
const scripted: Provider = {
  async runTurn(userText, ctx) {
    ctx.history.push({ role: 'user', content: userText })
    ctx.emit({ type: 'text', text: 'Writing the file. ' })
    const [outcome] = await ctx.runTools([{ id: 't1', name: 'write_file', input: { path: 'hello.txt', content: 'hi' } }])
    ctx.history.push({ role: 'tool', content: outcome.output })
    ctx.commit()
    ctx.emit({ type: 'text', text: outcome.isError ? 'It was denied.' : 'Done.' })
    return 'end_turn'
  },
}

let store: Store
let base = ''
let close: () => void

before(async () => {
  store = tempStore()
  const server = createServer({ store, agent: new Agent(store, () => scripted) })
  const port = await listen(server, 0, '127.0.0.1')
  base = `http://127.0.0.1:${port}`
  close = () => server.close()
})
after(() => close())

async function collect(gen: AsyncGenerator<AgentEvent>, onApproval?: (e: Extract<AgentEvent, { type: 'approval' }>) => Promise<void>) {
  const events: AgentEvent[] = []
  for await (const event of gen) {
    events.push(event)
    if (event.type === 'approval' && onApproval) await onApproval(event)
  }
  return events
}

test('full flow: setup, profile, session, approvals and transcript', async () => {
  const client = new HarnessClient(base)
  assert.equal(await client.needsSetup(), true)
  const { token, user } = await client.setup('admin', 'password123')
  client.token = token
  assert.equal(user.isAdmin, true)
  await assert.rejects(client.setup('again', 'password123'), (e: ApiError) => e.status === 409)

  const profile = await client.createProfile({ name: 'claude', provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-xyz-9999' })
  assert.equal((profile as unknown as Record<string, unknown>).apiKeySealed, undefined)
  assert.equal(profile.apiKeyHint, '…9999')

  const workspace = fs.mkdtempSync(path.join(store.dataDir, 'ws-'))
  const session = await client.createSession({ profileId: profile.id, workspace })

  // Ask mode: deny the write.
  const denied = await collect(client.send(session.id, 'make hello.txt'), (e) => client.approve(session.id, e.approvalId, false).then(() => undefined))
  assert.ok(denied.some((e) => e.type === 'tool_result' && e.isError))
  assert.equal(fs.existsSync(path.join(workspace, 'hello.txt')), false)

  // Approve with "always": the file is written and the session switches to auto mode.
  const allowed = await collect(client.send(session.id, 'try again'), (e) => client.approve(session.id, e.approvalId, true, true).then(() => undefined))
  assert.equal(allowed[allowed.length - 1].type, 'done')
  assert.equal(fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8'), 'hi')

  const saved = await client.session(session.id)
  assert.equal(saved.mode, 'auto')
  assert.equal(saved.title, 'make hello.txt')
  assert.deepEqual(saved.transcript.filter((t) => t.kind === 'user').map((t) => (t as { text: string }).text), ['make hello.txt', 'try again'])
  assert.equal((saved as unknown as Record<string, unknown>).history, undefined)
})

test('auth is required, admin routes are protected, cross-origin requests are refused', async () => {
  const anonymous = new HarnessClient(base)
  await assert.rejects(anonymous.profiles(), (e: ApiError) => e.status === 401)

  const admin = new HarnessClient(base)
  admin.token = (await admin.login('admin', 'password123')).token
  await admin.createUser({ username: 'bob', password: 'password123' })
  const bob = new HarnessClient(base)
  bob.token = (await bob.login('bob', 'password123')).token
  await assert.rejects(bob.users(), (e: ApiError) => e.status === 403)
  assert.deepEqual(await bob.profiles(), [])
  const bobProfile = await bob.createProfile({ name: 'local', provider: 'openai', model: 'm', baseUrl: 'http://localhost:1/v1' })
  await assert.rejects(bob.createSession({ profileId: bobProfile.id, workspace: '/' }), (e: ApiError) => e.status === 400)
  // Bob cannot see the admin's sessions.
  assert.deepEqual(await bob.sessions(), [])

  const res = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${admin.token}`, Origin: 'https://evil.example' } })
  assert.equal(res.status, 403)
})

test('serves the web GUI with a strict content security policy', async () => {
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/)
  assert.match(await res.text(), /Forge Harness/)
  assert.equal((await fetch(`${base}/../package.json`)).status, 404)
})
