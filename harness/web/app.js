'use strict'

// Forge Harness web GUI. Plain browser JavaScript, no build step.

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

const state = {
  token: safeGet('harness.token') || '',
  user: null,
  profiles: [],
  sessions: [],
  current: null,
  running: false,
}

const PRESETS = [
  { label: 'Claude (Anthropic)', name: 'claude', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high', baseUrl: '' },
  { label: 'OpenAI', name: 'openai', provider: 'openai', model: '', effort: '', baseUrl: '' },
  { label: 'Ollama (local)', name: 'ollama', provider: 'openai', model: 'qwen3-coder', effort: '', baseUrl: 'http://localhost:11434/v1' },
  { label: 'OpenRouter', name: 'openrouter', provider: 'openai', model: '', effort: '', baseUrl: 'https://openrouter.ai/api/v1' },
]

function safeGet(key) {
  try { return localStorage.getItem(key) } catch { return null }
}
function safeSet(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value) } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- API

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && path !== '/api/login') {
    signOutLocal()
    throw new Error('Please sign in again.')
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function* stream(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let i
    while ((i = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, i)
      buffer = buffer.slice(i + 2)
      if (/^event: /m.test(frame)) continue
      const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')
      if (data) yield JSON.parse(data)
    }
  }
}

// ---------------------------------------------------------------- auth

async function boot() {
  const { needsSetup } = await api('GET', '/api/setup')
  if (needsSetup) return showAuth('setup')
  if (state.token) {
    try {
      state.user = await api('GET', '/api/me')
      return enterApp()
    } catch { /* fall through to sign-in */ }
  }
  showAuth('login')
}

function showAuth(mode) {
  $('#app').classList.add('hidden')
  $('#auth').classList.remove('hidden')
  $('#auth').dataset.mode = mode
  $('#auth-intro').textContent = mode === 'setup'
    ? 'Welcome! Create the administrator account. You can add more users later.'
    : 'Sign in to continue.'
  $('#auth-submit').textContent = mode === 'setup' ? 'Create admin account' : 'Sign in'
  $('#auth-error').classList.add('hidden')
  $('#auth-form [name=username]').focus()
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = new FormData(e.target)
  const body = { username: form.get('username'), password: form.get('password') }
  try {
    const mode = $('#auth').dataset.mode
    const result = await api('POST', mode === 'setup' ? '/api/setup' : '/api/login', body)
    state.token = result.token
    state.user = result.user
    safeSet('harness.token', result.token)
    e.target.reset()
    enterApp()
  } catch (err) {
    $('#auth-error').textContent = err.message
    $('#auth-error').classList.remove('hidden')
  }
})

function signOutLocal() {
  state.token = ''
  state.user = null
  state.current = null
  safeSet('harness.token', null)
  showAuth('login')
}

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {})
  signOutLocal()
})

async function enterApp() {
  $('#auth').classList.add('hidden')
  $('#app').classList.remove('hidden')
  $('#whoami').textContent = `${state.user.username}${state.user.isAdmin ? ' · admin' : ''}`
  $('#users-tab').classList.toggle('hidden', !state.user.isAdmin)
  $('#web-tab').classList.toggle('hidden', !state.user.isAdmin)
  await refreshProfiles()
  await refreshSessions()
  if (!state.profiles.length) {
    openSettings('profiles')
    return
  }
  const last = safeGet('harness.lastSession')
  const pick = state.sessions.find((s) => s.id === last) || state.sessions[0]
  if (pick) await openSession(pick.id)
  else openNewSession()
}

// ---------------------------------------------------------------- sessions

async function refreshSessions() {
  state.sessions = await api('GET', '/api/sessions')
  const list = $('#session-list')
  list.replaceChildren()
  for (const s of state.sessions) {
    const btn = el('button', { class: `session-item${state.current?.id === s.id ? ' active' : ''}` })
    const title = el('span', { class: 't' })
    if (s.running) title.append(el('span', { class: 'running-dot' }))
    title.append(s.title)
    btn.append(title, el('span', { class: 'm', text: `${s.model} · ${timeAgo(s.updatedAt)}` }))
    btn.addEventListener('click', () => { openSession(s.id); closeSidebar() })
    list.append(btn)
  }
  if (!state.sessions.length) list.append(el('p', { class: 'muted small', text: 'No sessions yet.' }))
}

async function refreshProfiles() {
  state.profiles = await api('GET', '/api/profiles')
}

async function openSession(id) {
  const session = await api('GET', `/api/sessions/${id}`)
  state.current = session
  safeSet('harness.lastSession', id)
  renderHeader()
  const box = $('#messages')
  box.replaceChildren()
  if (!session.transcript.length) box.append(emptyState())
  const view = new TurnView(box)
  for (const item of session.transcript) view.addItem(item)
  scrollToEnd(true)
  await refreshSessions()
  if (session.running) await consume(stream('GET', `/api/sessions/${id}/stream`))
}

const EMPTY_TEMPLATE = $('#empty').cloneNode(true)
function emptyState() {
  return EMPTY_TEMPLATE.cloneNode(true)
}

function renderHeader() {
  const s = state.current
  if (!s) return
  const profile = state.profiles.find((p) => p.id === s.profileId)
  $('#session-title').value = s.title
  const tokens = s.usage ? ` · ${formatTokens(s.usage.inputTokens)} in / ${formatTokens(s.usage.outputTokens)} out` : ''
  $('#session-meta').textContent = `${s.workspace}${tokens}`
  $('#session-meta').title = $('#session-meta').textContent
  $('#model-label').textContent = `${profile ? profile.name : 'deleted profile'} · ${s.model}`
  $('#model-button').title = `Change model (now ${s.model} via ${profile ? profile.name : 'a deleted profile'})`
  $('#model-dot').className = `dot ${s.provider}`
  const web = s.web !== false
  $('#web-toggle').setAttribute('aria-pressed', String(web))
  $('#web-toggle').title = web ? 'Web access is on: the agent can search and read web pages' : 'Web access is off'
  for (const btn of $$('.mode-toggle button')) btn.classList.toggle('active', btn.dataset.mode === s.mode)
}

$('#web-toggle').addEventListener('click', async () => {
  if (!state.current) return
  const web = state.current.web === false
  state.current = { ...state.current, ...(await api('PATCH', `/api/sessions/${state.current.id}`, { web })) }
  renderHeader()
})

// ---------------------------------------------------------------- model picker

const modelCache = new Map()

async function profileModels(profile) {
  if (!modelCache.has(profile.id)) {
    modelCache.set(profile.id, api('GET', `/api/profiles/${profile.id}/models`).catch((err) => ({ models: [], error: err.message })))
  }
  return modelCache.get(profile.id)
}

$('#model-button').addEventListener('click', () => openModelPicker())
$('#close-models').addEventListener('click', () => $('#model-dialog').close())
$('#model-filter').addEventListener('input', () => filterModels())

async function openModelPicker() {
  if (!state.current) return
  if (state.running) return alert('Wait for the current turn to finish, or stop it, before switching models.')
  $('#model-error').classList.add('hidden')
  $('#model-filter').value = ''
  const groups = $('#model-groups')
  groups.replaceChildren()
  $('#model-dialog').showModal()
  for (const profile of state.profiles) {
    const group = el('section', { class: 'model-group' })
    const head = el('h3')
    head.append(el('span', { class: `dot ${profile.provider}` }), profile.name, el('span', { class: 'muted small', text: profile.provider === 'anthropic' ? 'Anthropic' : profile.baseUrl || 'OpenAI' }))
    const list = el('div', { class: 'model-list' })
    list.append(el('span', { class: 'muted small', text: 'Loading models…' }))
    const custom = el('form', { class: 'custom-model' })
    const input = el('input', { placeholder: 'Other model id…', 'aria-label': `Other model for ${profile.name}` })
    custom.append(input, el('button', { text: 'Use' }))
    custom.addEventListener('submit', (e) => { e.preventDefault(); if (input.value.trim()) chooseModel(profile, input.value.trim()) })
    group.append(head, list, custom)
    groups.append(group)
    profileModels(profile).then(({ models, error }) => {
      const ids = Array.from(new Set([profile.model, ...(models || [])]))
      list.replaceChildren()
      for (const id of ids) {
        const current = state.current.profileId === profile.id && state.current.model === id
        const b = el('button', { type: 'button', class: current ? 'current' : '', text: id, 'data-model': id })
        b.addEventListener('click', () => chooseModel(profile, id))
        list.append(b)
      }
      if (error) list.append(el('span', { class: 'muted small', text: 'Could not list models; type one below.' }))
      filterModels()
    })
  }
}

function filterModels() {
  const q = $('#model-filter').value.trim().toLowerCase()
  for (const b of $$('#model-groups .model-list button')) b.classList.toggle('hidden', Boolean(q) && !b.dataset.model.toLowerCase().includes(q))
}

async function chooseModel(profile, model) {
  try {
    state.current = await api('POST', `/api/sessions/${state.current.id}/model`, { profileId: profile.id, model })
    $('#model-dialog').close()
    await openSession(state.current.id)
  } catch (err) {
    $('#model-error').textContent = err.message
    $('#model-error').classList.remove('hidden')
  }
}

$('#session-title').addEventListener('change', async (e) => {
  if (!state.current || !e.target.value.trim()) return
  state.current = { ...state.current, ...(await api('PATCH', `/api/sessions/${state.current.id}`, { title: e.target.value })) }
  refreshSessions()
})

for (const btn of $$('.mode-toggle button')) {
  btn.addEventListener('click', async () => {
    if (!state.current) return
    state.current = { ...state.current, ...(await api('PATCH', `/api/sessions/${state.current.id}`, { mode: btn.dataset.mode })) }
    renderHeader()
  })
}

// ---------------------------------------------------------------- new session

$('#new-session').addEventListener('click', () => openNewSession())

function openNewSession() {
  if (!state.profiles.length) return openSettings('profiles')
  const form = $('#new-session-form')
  const select = form.elements.profileId
  select.replaceChildren(...state.profiles.map((p) => el('option', { value: p.id, text: `${p.name} — ${p.model}` })))
  const lastProfile = safeGet('harness.lastProfile')
  if (state.profiles.some((p) => p.id === lastProfile)) select.value = lastProfile
  const fillModels = async () => {
    const profile = state.profiles.find((p) => p.id === select.value)
    form.elements.model.value = ''
    form.elements.model.placeholder = profile ? `${profile.model} (profile default)` : ''
    const list = $('#model-options')
    list.replaceChildren()
    if (!profile) return
    const { models } = await profileModels(profile)
    list.replaceChildren(...(models || []).map((id) => el('option', { value: id })))
  }
  select.onchange = fillModels
  fillModels()
  const roots = state.user.workspaceRoots || []
  form.elements.workspace.value = safeGet('harness.lastWorkspace') || roots[0] || ''
  $('#workspace-hint').textContent = state.user.isAdmin
    ? 'Any folder on this machine.'
    : `Must be inside: ${roots.join(', ')}`
  $('#new-session-error').classList.add('hidden')
  $('#new-session-dialog').showModal()
}

$('#new-session-form').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return
  e.preventDefault()
  const form = e.target
  try {
    const body = {
      profileId: form.elements.profileId.value,
      model: form.elements.model.value.trim() || undefined,
      workspace: form.elements.workspace.value.trim() || undefined,
      mode: form.elements.mode.value,
    }
    const session = await api('POST', '/api/sessions', body)
    safeSet('harness.lastProfile', body.profileId)
    if (body.workspace) safeSet('harness.lastWorkspace', body.workspace)
    $('#new-session-dialog').close()
    await openSession(session.id)
    $('#prompt').focus()
  } catch (err) {
    $('#new-session-error').textContent = err.message
    $('#new-session-error').classList.remove('hidden')
  }
})

// ---------------------------------------------------------------- chat

const prompt = $('#prompt')
prompt.addEventListener('input', autosize)
prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $('#composer').requestSubmit()
  }
})
function autosize() {
  prompt.style.height = 'auto'
  prompt.style.height = `${Math.min(prompt.scrollHeight, 220)}px`
}

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault()
  const text = prompt.value.trim()
  if (!text || state.running) return
  if (!state.current) return openNewSession()
  prompt.value = ''
  autosize()
  askNotificationPermission()
  $('#empty')?.remove()
  new TurnView($('#messages')).addItem({ kind: 'user', text })
  scrollToEnd(true)
  await consume(stream('POST', `/api/sessions/${state.current.id}/messages`, { text }))
})

$('#stop').addEventListener('click', () => {
  if (state.current) api('POST', `/api/sessions/${state.current.id}/cancel`).catch(() => {})
})

function setRunning(running) {
  state.running = running
  $('#send').classList.toggle('hidden', running)
  $('#stop').classList.toggle('hidden', !running)
  $('#statusbar').classList.toggle('hidden', !running)
  document.title = running ? '● Forge Harness' : 'Forge Harness'
}

// Tracks what the agent is doing right now, for the status bar.
class Activity {
  constructor() {
    this.started = Date.now()
    this.steps = 0
    this.plan = null
    this.text = 'Starting…'
    this.timer = setInterval(() => this.render(), 1000)
    this.render()
  }

  set(text) {
    this.text = text
    this.render()
  }

  onEvent(ev) {
    switch (ev.type) {
      case 'thinking': this.set('Thinking…'); break
      case 'progress': this.set(ev.text.trim().split('\n')[0].slice(0, 160) || 'Working…'); break
      case 'text': this.set('Writing the answer…'); break
      case 'status': this.set(ev.text); break
      case 'tool_call': this.steps += 1; this.set(describeActivity(ev.name, ev.input)); break
      case 'web': this.steps += 1; this.set(ev.action === 'search' ? `Searching the web: ${ev.query || ''}` : `Reading ${ev.url || 'a web page'}`); break
      case 'approval': this.set(`Waiting for your approval: ${ev.name}`); notify('Approval needed', `The agent wants to run ${ev.name}.`); break
      case 'question': this.set('Waiting for your answer'); notify('The agent has a question', ev.question); break
      case 'approval_resolved':
      case 'question_resolved': this.set('Continuing…'); break
      case 'plan': this.plan = ev.items; this.render(); break
      case 'summary': notify(ev.stopReason === 'cancelled' ? 'Task cancelled' : 'Task finished', `${formatDuration(ev.seconds)} · ${ev.steps} steps`); break
    }
  }

  render() {
    const seconds = Math.round((Date.now() - this.started) / 1000)
    let planText = ''
    if (this.plan && this.plan.length) {
      const done = this.plan.filter((i) => i.status === 'done').length
      planText = ` · plan ${done}/${this.plan.length}`
    }
    $('#status-text').textContent = this.text
    $('#status-meta').textContent = `${formatDuration(seconds)} · ${this.steps} step${this.steps === 1 ? '' : 's'}${planText}`
  }

  stop() {
    clearInterval(this.timer)
  }
}

function describeActivity(name, input = {}) {
  switch (name) {
    case 'run_command': return `Running: ${input.command || ''}`
    case 'write_file': return `Writing ${input.path || 'a file'}`
    case 'edit_file': return `Editing ${input.path || 'a file'}`
    case 'read_file': return `Reading ${input.path || 'a file'}`
    case 'list_dir': return `Looking at ${input.path || 'the workspace'}`
    case 'search': return `Searching the code for ${input.pattern || ''}`
    case 'web_search': return `Searching the web: ${input.query || ''}`
    case 'web_fetch': return `Reading ${input.url || 'a web page'}`
    case 'update_plan': return 'Updating the plan'
    case 'ask_user': return 'Waiting for your answer'
    default: return `Running ${name}`
  }
}

async function consume(events) {
  const sessionId = state.current.id
  const view = new TurnView($('#messages'))
  const activity = new Activity()
  setRunning(true)
  refreshSessions()
  try {
    for await (const event of events) {
      if (state.current?.id !== sessionId) return
      activity.onEvent(event)
      view.addEvent(event)
      scrollToEnd()
    }
  } catch (err) {
    view.addItem({ kind: 'error', text: err.message })
  } finally {
    activity.stop()
    setRunning(false)
    if (state.current?.id === sessionId) {
      state.current = await api('GET', `/api/sessions/${sessionId}`).catch(() => state.current)
      renderHeader()
    }
    refreshSessions()
  }
}

// Desktop notifications when the tab is in the background.
function askNotificationPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
  } catch { /* not supported */ }
}

function notify(title, body) {
  if (!document.hidden) return
  document.title = `● ${title} — Forge Harness`
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body: String(body || '').slice(0, 200), icon: 'icon.svg', tag: 'forge-harness' })
      n.onclick = () => { window.focus(); n.close() }
    }
  } catch { /* not supported */ }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = state.running ? '● Forge Harness' : 'Forge Harness'
})

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60)
  return m ? `${m}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
}

// Renders transcript items (history) and live events into the message list.
class TurnView {
  constructor(box) {
    this.box = box
    this.textEl = null
    this.textBuf = ''
    this.thinkEl = null
    this.progressEl = null
    this.tools = new Map()
    this.webCards = new Map()
    this.approvals = new Map()
    this.questions = new Map()
    this.planEl = null
    this.hiddenTools = new Set()
  }

  addItem(item) {
    switch (item.kind) {
      case 'user':
        this.reset()
        this.planEl = null
        this.box.append(el('div', { class: 'msg-user', text: item.text }))
        break
      case 'text': this.appendText(item.text); this.textEl = null; break
      case 'thinking': this.appendThinking(item.text); this.thinkEl = null; break
      case 'progress': this.appendProgress(item.text); this.progressEl = null; break
      case 'tool_call': this.toolCall(item.id, item.name, item.input); break
      case 'tool_result': this.toolResult(item.id, item.output, item.isError); break
      case 'notice': this.reset(); this.box.append(el('div', { class: 'notice', text: item.text })); break
      case 'error': this.reset(); this.box.append(el('div', { class: 'err-msg', text: item.text })); break
      case 'web':
        this.webStart(item)
        if (item.results || item.error || item.title) this.webResult(item)
        break
      case 'plan': this.plan(item.items); break
      case 'question': this.question({ questionId: item.id, question: item.question, options: item.options, allowText: true }, item.answer); break
      case 'summary': this.summary(item); break
    }
  }

  addEvent(ev) {
    switch (ev.type) {
      case 'text': this.appendText(ev.text); break
      case 'thinking': this.appendThinking(ev.text); break
      case 'progress': this.appendProgress(ev.text); break
      case 'tool_call': this.toolCall(ev.id, ev.name, ev.input); break
      case 'tool_result': this.toolResult(ev.id, ev.output, ev.isError); break
      case 'approval': this.approval(ev); break
      case 'approval_resolved': this.approvals.get(ev.approvalId)?.remove(); break
      case 'web': this.webStart(ev); break
      case 'web_result': this.webResult(ev); break
      case 'plan': this.plan(ev.items); break
      case 'question': this.question(ev); break
      case 'question_resolved': this.questions.get(ev.questionId)?.(ev.answer); break
      case 'summary': this.summary(ev); break
      case 'notice': this.addItem({ kind: 'notice', text: ev.text }); break
      case 'error': this.addItem({ kind: 'error', text: ev.message }); break
      case 'usage':
        if (state.current?.usage) {
          state.current.usage.inputTokens += ev.inputTokens
          state.current.usage.outputTokens += ev.outputTokens
          renderHeader()
        }
        break
    }
  }

  reset() {
    this.textEl = null
    this.thinkEl = null
    this.progressEl = null
  }

  appendText(text) {
    if (!this.textEl) {
      this.reset()
      this.textBuf = ''
      this.textEl = el('div', { class: 'msg-text' })
      this.box.append(this.textEl)
    }
    this.textBuf += text
    const target = this.textEl
    target.dataset.src = this.textBuf
    // Re-render markdown at most once per frame per block while streaming.
    if (!target.dataset.pending) {
      target.dataset.pending = '1'
      requestAnimationFrame(() => {
        delete target.dataset.pending
        renderMarkdown(target, target.dataset.src)
      })
    }
  }

  appendThinking(text) {
    if (!this.thinkEl) {
      this.reset()
      const details = el('details', { class: 'thinking' })
      details.append(el('summary', { text: 'Thinking' }), el('div'))
      this.box.append(details)
      this.thinkEl = details.lastChild
    }
    this.thinkEl.textContent += text
  }

  // Progress updates: the model's short notes between steps.
  appendProgress(text) {
    if (!this.progressEl) {
      this.reset()
      this.progressEl = el('div', { class: 'progress-note' })
      this.box.append(this.progressEl)
    }
    this.progressEl.textContent += text
  }

  toolCall(id, name, input) {
    this.reset()
    // These tools have their own cards (plan, question).
    if (name === 'update_plan' || name === 'ask_user') {
      this.hiddenTools.add(id)
      return
    }
    // Client-side web tools render like the built-in web tools.
    if (name === 'web_search' || name === 'web_fetch') {
      this.webStart({ id, action: name === 'web_search' ? 'search' : 'fetch', query: input?.query, url: input?.url })
      return
    }
    const card = el('details', { class: 'tool' })
    const summary = el('summary')
    summary.append(el('span', { text: '⚙' }), el('span', { class: 'name', text: name }), el('span', { class: 'arg', text: summarize(input) }), el('span', { class: 'status', text: 'running…' }))
    card.append(summary, el('pre', { text: JSON.stringify(input, null, 2) }))
    this.box.append(card)
    this.tools.set(id, card)
  }

  toolResult(id, output, isError) {
    if (this.hiddenTools.has(id)) return
    if (this.webCards.has(id)) {
      const urls = (output.match(/https?:\/\/[^\s]+/g) || []).slice(0, 8)
      const lines = output.split('\n')
      this.webResult({
        id,
        error: isError ? output : undefined,
        results: urls.map((url) => {
          const i = lines.findIndex((l) => l.includes(url))
          const titleLine = i > 0 ? lines[i - 1].replace(/^\d+\.\s*/, '').trim() : ''
          return { url, title: titleLine.startsWith('#') ? titleLine.slice(1).trim() : titleLine }
        }),
      })
      return
    }
    const card = this.tools.get(id)
    if (!card) return
    const status = $('.status', card)
    status.textContent = isError ? 'failed' : 'done'
    status.className = `status ${isError ? 'err' : 'ok'}`
    card.append(el('pre', { text: output }))
  }

  webStart(ev) {
    this.reset()
    const card = el('div', { class: 'web-card' })
    const head = el('div', { class: 'head' })
    head.append(
      el('span', { text: ev.action === 'search' ? '🔎' : '🌐' }),
      el('strong', { text: ev.action === 'search' ? 'Searched the web' : 'Read a page' }),
      el('span', { class: 'muted', text: ev.action === 'search' ? (ev.query ? `“${ev.query}”` : '') : ev.url || '' }),
    )
    const links = el('div', { class: 'links' })
    card.append(head, links)
    this.box.append(card)
    this.webCards.set(ev.id, card)
  }

  webResult(ev) {
    const card = this.webCards.get(ev.id)
    if (!card) return
    const links = $('.links', card)
    links.replaceChildren()
    if (ev.error) {
      links.append(el('span', { class: 'error', text: `Failed: ${String(ev.error).slice(0, 200)}` }))
      return
    }
    for (const r of (ev.results || []).slice(0, 6)) {
      const row = el('div')
      row.append(link(r.url, r.title || r.url), el('span', { class: 'host', text: hostOf(r.url) }))
      links.append(row)
    }
    if (ev.results && ev.results.length > 6) links.append(el('span', { class: 'muted small', text: `+${ev.results.length - 6} more` }))
    if (!ev.results && (ev.url || ev.title)) links.append(link(ev.url || '#', ev.title || ev.url))
  }

  plan(items) {
    this.reset()
    if (!this.planEl) {
      this.planEl = el('div', { class: 'plan-card' })
      this.box.append(this.planEl)
    }
    const done = items.filter((i) => i.status === 'done').length
    const head = el('h4')
    head.append(el('span', { text: '📋 Plan' }), el('span', { class: 'muted small', text: `${done}/${items.length} done` }))
    const list = el('ol')
    for (const item of items) {
      const li = el('li', { class: item.status })
      li.append(el('span', { text: item.status === 'done' ? '✅' : item.status === 'in_progress' ? '⏳' : '⬜' }), el('span', { text: item.text }))
      list.append(li)
    }
    const bar = el('div', { class: 'plan-bar' })
    const fill = el('span')
    fill.style.width = `${items.length ? Math.round((done / items.length) * 100) : 0}%`
    bar.append(fill)
    this.planEl.replaceChildren(head, list, bar)
  }

  // A question from the agent with clickable answers.
  question(ev, answered) {
    this.reset()
    const card = el('div', { class: 'question-card' })
    card.append(el('div', { class: 'q', text: `❓ ${ev.question}` }))
    const showAnswer = (answer) => {
      card.replaceChildren(el('div', { class: 'q', text: `❓ ${ev.question}` }), el('div', { class: 'answer', text: answer ? `You answered: ${answer}` : 'No answer given.' }))
    }
    if (answered !== undefined) {
      showAnswer(answered)
      this.box.append(card)
      return
    }
    const send = (answer) => {
      for (const b of $$('button, input', card)) b.disabled = true
      api('POST', `/api/sessions/${state.current.id}/answers/${ev.questionId}`, { answer }).catch((err) => this.addItem({ kind: 'error', text: err.message }))
    }
    if (ev.options && ev.options.length) {
      const options = el('div', { class: 'options' })
      ev.options.forEach((option, i) => {
        const b = el('button', { type: 'button', class: i === 0 ? 'primary' : '', text: option })
        b.addEventListener('click', () => send(option))
        options.append(b)
      })
      card.append(options)
    }
    if (ev.allowText !== false) {
      const form = el('form')
      const input = el('input', { placeholder: ev.options?.length ? 'Or type your own answer…' : 'Type your answer…', 'aria-label': 'Your answer' })
      form.append(input, el('button', { text: 'Send' }))
      form.addEventListener('submit', (e) => { e.preventDefault(); if (input.value.trim()) send(input.value.trim()) })
      card.append(form)
    }
    this.box.append(card)
    this.questions.set(ev.questionId, showAnswer)
    $('button, input', card)?.focus()
  }

  summary(ev) {
    this.reset()
    const icon = ev.stopReason === 'cancelled' ? '⏹' : ev.stopReason === 'error' || ev.stopReason === 'refusal' ? '⚠' : '✓'
    const tokens = ev.inputTokens || ev.outputTokens ? ` · ${formatTokens(ev.inputTokens)} in / ${formatTokens(ev.outputTokens)} out` : ''
    this.box.append(el('div', { class: 'summary-line', text: `${icon} ${ev.stopReason === 'cancelled' ? 'Stopped' : 'Finished'} in ${formatDuration(ev.seconds)} · ${ev.steps} step${ev.steps === 1 ? '' : 's'}${tokens}` }))
  }

  approval(ev) {
    this.reset()
    const box = el('div', { class: 'approval' })
    box.append(
      el('strong', { text: `Allow ${ev.name}?` }),
      el('pre', { text: describeApproval(ev.name, ev.input) }),
    )
    const row = el('div', { class: 'row' })
    const decide = (allow, always) => {
      for (const b of $$('button', row)) b.disabled = true
      api('POST', `/api/sessions/${state.current.id}/approvals/${ev.approvalId}`, { allow, always }).then(() => {
        if (always && state.current) { state.current.mode = 'auto'; renderHeader() }
      }).catch((err) => this.addItem({ kind: 'error', text: err.message }))
    }
    const allow = el('button', { class: 'primary', text: 'Allow' })
    const always = el('button', { text: 'Always allow in this session' })
    const deny = el('button', { class: 'ghost', text: 'Deny' })
    allow.addEventListener('click', () => decide(true, false))
    always.addEventListener('click', () => decide(true, true))
    deny.addEventListener('click', () => decide(false, false))
    row.append(allow, always, deny)
    box.append(row)
    this.box.append(box)
    this.approvals.set(ev.approvalId, box)
    allow.focus()
  }
}

function describeApproval(name, input) {
  if (name === 'run_command') return `$ ${input.command}`
  if (name === 'write_file') return `${input.path}\n\n${String(input.content).slice(0, 2000)}${String(input.content).length > 2000 ? '\n…' : ''}`
  if (name === 'edit_file') return `${input.path}\n\n− ${String(input.old_string).split('\n').join('\n− ')}\n+ ${String(input.new_string).split('\n').join('\n+ ')}`
  return JSON.stringify(input, null, 2)
}

function link(url, text) {
  const a = el('a', { href: /^https?:\/\//.test(url) ? url : '#', target: '_blank', rel: 'noopener noreferrer', text })
  a.title = url
  return a
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function summarize(input) {
  if (!input || typeof input !== 'object') return ''
  if (input.command) return input.command
  if (input.path) return input.path
  if (input.pattern) return input.pattern
  return JSON.stringify(input)
}

// ---------------------------------------------------------------- settings

$('#open-settings').addEventListener('click', () => openSettings('profiles'))
$('#close-settings').addEventListener('click', () => $('#settings').close())

for (const tab of $$('.tabs button')) tab.addEventListener('click', () => showTab(tab.dataset.tab))

function openSettings(tab) {
  renderProfiles()
  resetProfileForm()
  if (state.user.isAdmin) {
    renderUsers()
    loadSearchSettings()
  }
  showTab(tab)
  if (!$('#settings').open) $('#settings').showModal()
}

function showTab(name) {
  for (const t of $$('.tabs button')) t.classList.toggle('active', t.dataset.tab === name)
  for (const p of $$('.tab')) p.classList.toggle('hidden', p.dataset.panel !== name)
}

$('#settings').addEventListener('close', async () => {
  await refreshProfiles()
  if (!state.current && state.profiles.length) openNewSession()
  else renderHeader()
})

function renderProfiles() {
  const list = $('#profile-list')
  list.replaceChildren()
  if (!state.profiles.length) {
    list.append(el('p', { class: 'muted', text: 'Add your first provider profile below — pick a preset to start.' }))
  }
  for (const p of state.profiles) {
    const item = el('div', { class: 'list-item' })
    const info = el('div', { class: 'grow' })
    const name = el('div')
    name.append(el('strong', { text: p.name }), ' ', el('span', { class: 'badge', text: p.provider }))
    info.append(name, el('div', { class: 'muted small', text: `${p.model}${p.baseUrl ? ` · ${p.baseUrl}` : ''}${p.apiKeyHint ? ` · key ${p.apiKeyHint}` : ' · no key'}` }))
    const edit = el('button', { class: 'ghost', text: 'Edit' })
    const del = el('button', { class: 'ghost', text: 'Delete' })
    edit.addEventListener('click', () => fillProfileForm(p))
    del.addEventListener('click', async () => {
      if (!confirm(`Delete profile "${p.name}"? Sessions using it will stop working.`)) return
      await api('DELETE', `/api/profiles/${p.id}`)
      await refreshProfiles()
      renderProfiles()
    })
    item.append(info, edit, del)
    list.append(item)
  }
  const presets = $('#presets')
  presets.replaceChildren(el('span', { class: 'muted small', text: 'Presets:' }))
  for (const preset of PRESETS) {
    const b = el('button', { type: 'button', text: preset.label })
    b.addEventListener('click', () => {
      const f = $('#profile-form').elements
      f.id.value = ''
      for (const key of ['name', 'provider', 'model', 'effort', 'baseUrl']) f[key].value = preset[key]
      $('#profile-form-title').textContent = 'Add a profile'
      f.model.focus()
    })
    presets.append(b)
  }
}

function fillProfileForm(p) {
  const f = $('#profile-form').elements
  f.id.value = p.id
  for (const key of ['name', 'provider', 'model', 'baseUrl']) f[key].value = p[key] || ''
  f.effort.value = p.effort || ''
  f.apiKey.value = ''
  f.thinking.checked = p.thinking
  f.fallbacks.checked = p.fallbacks
  $('#profile-form-title').textContent = `Edit ${p.name}`
}

function resetProfileForm() {
  $('#profile-form').reset()
  $('#profile-form').elements.id.value = ''
  $('#profile-form-title').textContent = 'Add a profile'
  $('#profile-error').classList.add('hidden')
}
$('#profile-reset').addEventListener('click', resetProfileForm)

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = e.target.elements
  const body = {
    name: f.name.value,
    provider: f.provider.value,
    model: f.model.value,
    baseUrl: f.baseUrl.value.trim(),
    effort: f.effort.value || null,
    thinking: f.thinking.checked,
    fallbacks: f.fallbacks.checked,
  }
  if (f.apiKey.value) body.apiKey = f.apiKey.value
  try {
    if (f.id.value) await api('PATCH', `/api/profiles/${f.id.value}`, body)
    else await api('POST', '/api/profiles', body)
    await refreshProfiles()
    renderProfiles()
    resetProfileForm()
  } catch (err) {
    $('#profile-error').textContent = err.message
    $('#profile-error').classList.remove('hidden')
  }
})

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = e.target.elements
  const msg = $('#password-msg')
  try {
    await api('POST', '/api/me/password', { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value })
    e.target.reset()
    msg.textContent = 'Password updated.'
    msg.className = 'small'
  } catch (err) {
    msg.textContent = err.message
    msg.className = 'small error'
  }
})

async function loadSearchSettings() {
  const { search } = await api('GET', '/api/settings')
  const f = $('#search-form').elements
  f.provider.value = search.provider
  f.baseUrl.value = search.baseUrl || ''
  f.apiKey.value = ''
  f.apiKey.placeholder = search.hasKey ? 'A key is saved; leave blank to keep it' : 'Stored encrypted'
  $('#search-msg').textContent = ''
}

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = e.target.elements
  const msg = $('#search-msg')
  try {
    const search = { provider: f.provider.value, baseUrl: f.baseUrl.value }
    if (f.apiKey.value) search.apiKey = f.apiKey.value
    await api('PATCH', '/api/settings', { search })
    await loadSearchSettings()
    msg.textContent = 'Saved.'
    msg.className = 'small'
  } catch (err) {
    msg.textContent = err.message
    msg.className = 'small error'
  }
})

async function renderUsers() {
  const list = $('#user-list')
  list.replaceChildren()
  for (const u of await api('GET', '/api/users')) {
    const item = el('div', { class: 'list-item' })
    const info = el('div', { class: 'grow' })
    const name = el('div')
    name.append(el('strong', { text: u.username }), ' ')
    if (u.isAdmin) name.append(el('span', { class: 'badge', text: 'admin' }))
    info.append(name, el('div', { class: 'muted small', text: u.workspaceRoots.join(', ') }))
    item.append(info)
    if (u.id !== state.user.id) {
      const del = el('button', { class: 'ghost', text: 'Delete' })
      del.addEventListener('click', async () => {
        if (!confirm(`Delete user "${u.username}" and all of their sessions and profiles?`)) return
        await api('DELETE', `/api/users/${u.id}`)
        renderUsers()
      })
      item.append(del)
    }
    list.append(item)
  }
}

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = e.target.elements
  try {
    await api('POST', '/api/users', {
      username: f.username.value,
      password: f.password.value,
      isAdmin: f.isAdmin.checked,
      workspaceRoots: f.workspaceRoots.value.split(',').map((s) => s.trim()).filter(Boolean),
    })
    e.target.reset()
    $('#user-error').classList.add('hidden')
    renderUsers()
  } catch (err) {
    $('#user-error').textContent = err.message
    $('#user-error').classList.remove('hidden')
  }
})

// ---------------------------------------------------------------- mobile sidebar

$('#open-sidebar').addEventListener('click', () => $('#sidebar').classList.add('open'))
$('#close-sidebar').addEventListener('click', closeSidebar)
function closeSidebar() { $('#sidebar').classList.remove('open') }

// ---------------------------------------------------------------- helpers

function el(tag, attrs = {}) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value
    else if (key === 'class') node.className = value
    else node.setAttribute(key, value)
  }
  return node
}

function scrollToEnd(force) {
  const box = $('#messages')
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160
  if (force || nearBottom) box.scrollTop = box.scrollHeight
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

function formatTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}

// Small, safe markdown renderer: builds DOM nodes, never injects HTML.
function renderMarkdown(target, src) {
  target.replaceChildren()
  const lines = String(src || '').split('\n')
  let i = 0
  let list = null
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^```(\S*)/)
    if (fence) {
      const code = []
      i += 1
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++])
      i += 1
      const pre = el('pre')
      pre.append(el('code', { text: code.join('\n') }))
      target.append(pre)
      list = null
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.*)/)
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/)
    if (heading) {
      const h = el(`h${heading[1].length}`)
      inline(h, heading[2])
      target.append(h)
      list = null
    } else if (item) {
      if (!list) { list = el('ul'); target.append(list) }
      const li = el('li')
      inline(li, item[1])
      list.append(li)
    } else if (line.trim()) {
      const p = el('p')
      const para = [line]
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(```|#{1,3}\s|\s*(?:[-*]|\d+\.)\s)/.test(lines[i + 1])) para.push(lines[++i])
      inline(p, para.join('\n'))
      target.append(p)
      list = null
    } else {
      list = null
    }
    i += 1
  }
}

function inline(parent, text) {
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) parent.append(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) parent.append(el('code', { text: tok.slice(1, -1) }))
    else if (tok.startsWith('**')) parent.append(el('strong', { text: tok.slice(2, -2) }))
    else {
      const [, label, href] = tok.match(/^\[([^\]]+)\]\((.*)\)$/)
      parent.append(el('a', { href, text: label, target: '_blank', rel: 'noopener noreferrer' }))
    }
    last = m.index + tok.length
  }
  if (last < text.length) parent.append(text.slice(last))
}

boot().catch((err) => {
  document.body.textContent = `Could not reach the Forge Harness engine: ${err.message}`
})
