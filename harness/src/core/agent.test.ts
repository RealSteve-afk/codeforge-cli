import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tempStore } from '../test-helpers'
import { Agent, type Run } from './agent'
import type { AgentEvent, Provider } from './providers/types'

function waitDone(run: Run): Promise<AgentEvent[]> {
  return new Promise((resolve) => {
    const events: AgentEvent[] = []
    run.subscribe((event) => {
      events.push(event)
      if (event.type === 'done') resolve(events)
    })
  })
}

function setup(provider: Provider) {
  const store = tempStore()
  const user = store.createUser({ username: 'alice', password: 'longenough', isAdmin: true })
  const profile = store.createProfile(user.id, { name: 'p', provider: 'openai', model: 'm', baseUrl: 'http://localhost:1/v1' })
  const session = store.createSession(user, { profileId: profile.id })
  return { store, user, session, agent: new Agent(store, () => provider) }
}

test('a failed turn rolls history back to the last consistent point', async () => {
  const { store, user, session, agent } = setup({
    async runTurn(text, ctx) {
      ctx.history.push({ role: 'user', content: text }, { role: 'assistant', content: 'partial tool call' })
      throw new Error('network down')
    },
  })
  const events = await waitDone(agent.start(user, session.id, 'hello'))
  assert.ok(events.some((e) => e.type === 'error' && e.message === 'network down'))
  const saved = store.getSession(user.id, session.id)
  assert.deepEqual(saved.history, [])
  assert.deepEqual(saved.transcript.map((t) => t.kind), ['user', 'error'])
})

test('invalid tool input is rejected before the tool runs', async () => {
  const { user, session, agent } = setup({
    async runTurn(_text, ctx) {
      const [outcome] = await ctx.runTools([{ id: 'x', name: 'read_file', input: { INVALID_JSON: '{"pa' } }])
      ctx.emit({ type: 'text', text: outcome.output })
      return 'end_turn'
    },
  })
  const events = await waitDone(agent.start(user, session.id, 'go'))
  const result = events.find((e) => e.type === 'tool_result')
  assert.ok(result && result.type === 'tool_result' && result.isError)
  assert.match(result.output, /INVALID_JSON/)
})

test('cancel aborts a turn that is waiting for approval', async () => {
  const { user, session, agent } = setup({
    async runTurn(_text, ctx) {
      const [outcome] = await ctx.runTools([{ id: 'w', name: 'run_command', input: { command: 'echo hi' } }])
      if (ctx.signal.aborted) throw new Error('aborted')
      return outcome.isError ? 'denied' : 'ran'
    },
  })
  const run = agent.start(user, session.id, 'run it')
  const done = waitDone(run)
  await new Promise<void>((resolve) => run.subscribe((e) => e.type === 'approval' && resolve()))
  assert.throws(() => agent.start(user, session.id, 'second'), /already running/)
  assert.equal(agent.cancel(user.id, session.id), true)
  const events = await done
  assert.deepEqual(events[events.length - 1], { type: 'done', stopReason: 'cancelled' })
})
