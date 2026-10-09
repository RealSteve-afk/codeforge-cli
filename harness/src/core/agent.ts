import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import os from 'os'
import { randomToken } from './crypto'
import { anthropicProvider } from './providers/anthropic'
import { openaiProvider } from './providers/openai'
import type { AgentEvent, Provider, ToolCall, ToolOutcome } from './providers/types'
import { type ProviderKind, type PublicProfile, type PublicUser, type Session, type Store, type TranscriptItem, UserError } from './store'
import { findTool, type PlanItem, type ToolDef, ToolError, toolsFor } from './tools'
import { extractUrls, normalizeUrl } from './web'

export type ProviderFactory = (profile: PublicProfile, apiKey: string | undefined, model: string) => Provider

export const defaultProviderFactory: ProviderFactory = (profile, apiKey, model) =>
  profile.provider === 'anthropic'
    ? anthropicProvider({
        apiKey: apiKey ?? '',
        model,
        baseUrl: profile.baseUrl,
        effort: profile.effort,
        thinking: profile.thinking,
        fallbacks: profile.fallbacks,
      })
    : openaiProvider({ apiKey, model, baseUrl: profile.baseUrl, effort: profile.effort })

type Listener = (event: AgentEvent) => void

// One in-flight turn. Clients can attach at any time; they get a replay of the
// turn's events so far, then live events.
export class Run {
  readonly id = `run_${randomToken(9)}`
  readonly events: AgentEvent[] = []
  readonly controller = new AbortController()
  readonly approvals = new Map<string, (decision: { allow: boolean; always: boolean }) => void>()
  readonly questions = new Map<string, (answer: string) => void>()
  private readonly listeners = new Set<Listener>()
  done = false

  constructor(
    readonly sessionId: string,
    readonly userId: string,
  ) {}

  emit(event: AgentEvent): void {
    this.events.push(event)
    for (const listener of this.listeners) listener(event)
  }

  subscribe(listener: Listener): () => void {
    for (const event of this.events) listener(event)
    if (this.done) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export function systemPrompt(session: Session): string {
  return [
    'You are a capable software engineering agent running inside Forge Harness.',
    `You are working in the workspace directory ${session.workspace} on ${os.platform()}.`,
    'Use the tools to inspect files, make changes and run commands; tool paths are relative to the workspace root.',
    'Read code before you change it, keep changes focused on what was asked, and run the relevant tests or build when one exists.',
    'Some tool calls need the user to approve them; if a call is denied, adjust your plan instead of retrying the same call.',
    'For a task with three or more steps, show your plan with update_plan and keep it current as steps finish.',
    'Use ask_user only for decisions the user must make; otherwise make a sensible choice and say what you chose.',
    'When web tools are available, use them for current or unfamiliar information and mention the URLs you relied on.',
    'When you finish, reply with a short summary of what you did and anything left for the user to decide.',
  ].join('\n')
}

// Rebuilds provider-native history from the saved transcript. Used when a
// session moves to another account or provider, whose native formats and
// thinking blocks cannot be carried over.
export function historyFromTranscript(transcript: TranscriptItem[], kind: ProviderKind, system: string): unknown[] {
  const messages: Array<{ role: string; content: string }> = kind === 'openai' ? [{ role: 'system', content: system }] : []
  let assistant: string[] = []
  const flush = (): void => {
    if (assistant.length) messages.push({ role: 'assistant', content: assistant.join('\n\n') })
    assistant = []
  }
  for (const item of transcript) {
    switch (item.kind) {
      case 'user':
        flush()
        messages.push({ role: 'user', content: item.text })
        break
      case 'text':
        if (item.text.trim()) assistant.push(item.text)
        break
      case 'tool_call':
        assistant.push(`(tool log) called ${item.name} ${JSON.stringify(item.input).slice(0, 400)}`)
        break
      case 'tool_result':
        assistant.push(`(tool log) result${item.isError ? ' [error]' : ''}: ${item.output.slice(0, 1500)}`)
        break
      case 'web':
        assistant.push(
          `(tool log) web ${item.action} ${item.query ?? item.url ?? ''}${item.results?.length ? ` → ${item.results.map((r) => r.url).join(', ')}` : ''}`,
        )
        break
      case 'question':
        assistant.push(`(tool log) asked the user "${item.question}" → ${item.answer ?? 'no answer'}`)
        break
    }
  }
  flush()
  return messages
}

export class Agent {
  private readonly runs = new Map<string, Run>()

  constructor(
    private readonly store: Store,
    private readonly providerFactory: ProviderFactory = defaultProviderFactory,
  ) {}

  activeRun(userId: string, sessionId: string): Run | undefined {
    const run = this.runs.get(sessionId)
    return run && run.userId === userId ? run : undefined
  }

  private isRunning(sessionId: string): boolean {
    const run = this.runs.get(sessionId)
    return Boolean(run && !run.done)
  }

  start(user: PublicUser, sessionId: string, text: string): Run {
    const prompt = text.trim()
    if (!prompt) throw new UserError('message is empty')
    const session = this.store.getSession(user.id, sessionId)
    if (this.isRunning(sessionId)) throw new UserError('this session is already running a turn')
    const profile = this.store.getProfile(user.id, session.profileId)
    const apiKey = this.store.profileApiKey(user.id, session.profileId)
    const run = new Run(sessionId, user.id)
    this.runs.set(sessionId, run)
    void this.execute(run, session, profile, apiKey, prompt)
    return run
  }

  // Moves a session to another profile and/or model. The conversation carries over.
  switchModel(user: PublicUser, sessionId: string, input: { profileId?: string; model?: string }): Session {
    if (this.isRunning(sessionId)) throw new UserError('wait for the current turn to finish before switching models')
    const session = this.store.getSession(user.id, sessionId)
    const profile = this.store.getProfile(user.id, input.profileId || session.profileId)
    const model = (input.model || (profile.id === session.profileId ? session.model : profile.model)).trim()
    if (!model) throw new UserError('model is required')
    if (profile.id === session.profileId && model === session.model) return session
    // Same account: keep native history (other models simply ignore foreign thinking blocks).
    // Different account or provider: rebuild from the transcript.
    if (profile.id !== session.profileId) session.history = historyFromTranscript(session.transcript, profile.provider, systemPrompt(session))
    session.profileId = profile.id
    session.provider = profile.provider
    session.model = model
    session.transcript.push({ kind: 'notice', text: `Switched to ${profile.name} · ${model}` })
    this.store.saveSession(session)
    return session
  }

  resolveApproval(userId: string, sessionId: string, approvalId: string, allow: boolean, always = false): void {
    const run = this.activeRun(userId, sessionId)
    const resolve = run?.approvals.get(approvalId)
    if (!run || !resolve) throw new UserError('no pending approval with that id')
    run.approvals.delete(approvalId)
    resolve({ allow, always })
  }

  answerQuestion(userId: string, sessionId: string, questionId: string, answer: string): void {
    const run = this.activeRun(userId, sessionId)
    const resolve = run?.questions.get(questionId)
    if (!run || !resolve) throw new UserError('no pending question with that id')
    run.questions.delete(questionId)
    resolve(answer.trim())
  }

  cancel(userId: string, sessionId: string): boolean {
    const run = this.activeRun(userId, sessionId)
    if (!run || run.done) return false
    run.controller.abort()
    for (const [id, resolve] of run.approvals) {
      run.approvals.delete(id)
      resolve({ allow: false, always: false })
    }
    for (const [id, resolve] of run.questions) {
      run.questions.delete(id)
      resolve('')
    }
    return true
  }

  private async execute(run: Run, session: Session, profile: PublicProfile, apiKey: string | undefined, prompt: string): Promise<void> {
    const startedAt = Date.now()
    const transcript: TranscriptItem[] = [{ kind: 'user', text: prompt, at: new Date().toISOString() }]
    const usage = { inputTokens: 0, outputTokens: 0 }
    const history = [...session.history]
    let committed = history.length
    let steps = 0
    const title = session.title === 'New session' ? prompt.replace(/\s+/g, ' ').slice(0, 60) : session.title
    let autoApprove = session.mode === 'auto'
    const web = session.web !== false
    const search = this.store.searchConfig()

    const record = (event: AgentEvent): void => {
      const last = transcript[transcript.length - 1]
      switch (event.type) {
        case 'text':
        case 'thinking':
        case 'progress':
          if (last && last.kind === event.type) last.text += event.text
          else transcript.push({ kind: event.type, text: event.text })
          break
        case 'tool_call':
          transcript.push({ kind: 'tool_call', id: event.id, name: event.name, input: event.input })
          break
        case 'tool_result':
          transcript.push({ kind: 'tool_result', id: event.id, output: event.output, isError: event.isError })
          break
        case 'notice':
          transcript.push({ kind: 'notice', text: event.text })
          break
        case 'error':
          transcript.push({ kind: 'error', text: event.message })
          break
        case 'usage':
          usage.inputTokens += event.inputTokens
          usage.outputTokens += event.outputTokens
          break
        case 'web':
          transcript.push({ kind: 'web', id: event.id, action: event.action, query: event.query, url: event.url })
          break
        case 'web_result': {
          const item = transcript.find((t) => t.kind === 'web' && t.id === event.id)
          if (item && item.kind === 'web') Object.assign(item, { results: event.results, title: event.title, error: event.error, url: item.url ?? event.url })
          break
        }
        case 'plan': {
          // One plan card per turn, updated in place.
          const existing = transcript.find((t) => t.kind === 'plan')
          if (existing && existing.kind === 'plan') existing.items = event.items
          else transcript.push({ kind: 'plan', items: event.items })
          break
        }
        case 'question':
          transcript.push({ kind: 'question', id: event.questionId, question: event.question, options: event.options })
          break
        case 'question_resolved': {
          const item = transcript.find((t) => t.kind === 'question' && t.id === event.questionId)
          if (item && item.kind === 'question') item.answer = event.answer
          break
        }
        case 'summary':
          transcript.push({ kind: 'summary', seconds: event.seconds, steps: event.steps, stopReason: event.stopReason, inputTokens: event.inputTokens, outputTokens: event.outputTokens })
          break
      }
    }
    const emit = (event: AgentEvent): void => {
      record(event)
      run.emit(event)
    }

    // Merge this turn into the latest saved copy, so concurrent edits (title, mode) are kept.
    const persist = (): void => {
      const latest = this.store.getSession(session.userId, session.id)
      latest.history = history.slice(0, committed)
      latest.transcript = [...session.transcript, ...transcript]
      latest.usage = {
        inputTokens: session.usage.inputTokens + usage.inputTokens,
        outputTokens: session.usage.outputTokens + usage.outputTokens,
      }
      if (latest.title === 'New session') latest.title = title
      if (autoApprove) latest.mode = 'auto'
      this.store.saveSession(latest)
    }

    // web_fetch may only open URLs the user gave or that earlier results surfaced.
    const urlAllowed = (url: string): boolean => {
      const seen = new Set<string>()
      for (const item of [...session.transcript, ...transcript]) {
        const texts =
          item.kind === 'user' ? [item.text]
          : item.kind === 'tool_result' ? [item.output]
          : item.kind === 'web' ? (item.results ?? []).map((r) => r.url)
          : item.kind === 'question' ? [item.answer ?? '']
          : []
        for (const text of texts) for (const u of extractUrls(text)) seen.add(u)
      }
      return seen.has(normalizeUrl(url) ?? '')
    }

    const askUser = (question: string, options: string[], allowText: boolean): Promise<string> =>
      new Promise((resolve) => {
        const questionId = `qst_${randomToken(6)}`
        run.questions.set(questionId, (answer) => {
          emit({ type: 'question_resolved', questionId, answer })
          resolve(answer)
        })
        emit({ type: 'question', questionId, question, options, allowText })
      })

    let tools: ToolDef[] = []
    const runTools = async (calls: ToolCall[]): Promise<ToolOutcome[]> => {
      const outcomes: ToolOutcome[] = []
      for (const call of calls) {
        steps += 1
        emit({ type: 'tool_call', id: call.id, name: call.name, input: call.input })
        const outcome = await this.runTool(run, session, tools, call, {
          isAuto: () => autoApprove,
          enableAuto: () => {
            autoApprove = true
          },
          emit,
          askUser,
          updatePlan: (items) => emit({ type: 'plan', items }),
          search,
          urlAllowed,
        })
        emit({ type: 'tool_result', id: call.id, output: outcome.output, isError: outcome.isError })
        outcomes.push(outcome)
      }
      return outcomes
    }

    let stopReason = 'error'
    try {
      const provider = this.providerFactory(profile, apiKey, session.model)
      tools = toolsFor({ clientWeb: web && !provider.builtInWeb, searchConfigured: Boolean(search) })
      stopReason = await provider.runTurn(prompt, {
        history,
        commit: () => {
          committed = history.length
          persist()
        },
        system: systemPrompt(session),
        tools,
        runTools,
        emit,
        signal: run.controller.signal,
        web,
      })
    } catch (error) {
      if (run.controller.signal.aborted) {
        stopReason = 'cancelled'
        emit({ type: 'notice', text: 'turn cancelled' })
      } else {
        emit({ type: 'error', message: describeError(error) })
      }
    } finally {
      emit({
        type: 'summary',
        seconds: Math.round((Date.now() - startedAt) / 1000),
        steps,
        stopReason,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
      persist()
      run.done = true
      run.emit({ type: 'done', stopReason })
    }
  }

  private async runTool(
    run: Run,
    session: Session,
    tools: ToolDef[],
    call: ToolCall,
    hooks: {
      isAuto: () => boolean
      enableAuto: () => void
      emit: (event: AgentEvent) => void
      askUser: (question: string, options: string[], allowText: boolean) => Promise<string>
      updatePlan: (items: PlanItem[]) => void
      search: ReturnType<Store['searchConfig']>
      urlAllowed: (url: string) => boolean
    },
  ): Promise<ToolOutcome> {
    const tool = findTool(call.name, tools)
    if (!tool) return { id: call.id, output: `unknown tool "${call.name}"`, isError: true }
    // Streamed tool input is not validated by the API, so check it here before running anything.
    const parsed = tool.schema.safeParse(call.input)
    if (!parsed.success) {
      return { id: call.id, output: JSON.stringify({ INVALID_JSON: JSON.stringify(call.input), issues: parsed.error.issues.map((i) => i.message) }), isError: true }
    }
    if (run.controller.signal.aborted) return { id: call.id, output: 'cancelled by the user', isError: true }
    if (tool.mutates && !hooks.isAuto()) {
      const approvalId = `apr_${randomToken(6)}`
      const decision = await new Promise<{ allow: boolean; always: boolean }>((resolve) => {
        run.approvals.set(approvalId, resolve)
        hooks.emit({ type: 'approval', approvalId, toolCallId: call.id, name: call.name, input: parsed.data })
      })
      hooks.emit({ type: 'approval_resolved', approvalId, allowed: decision.allow })
      if (!decision.allow) return { id: call.id, output: 'the user denied this tool call', isError: true }
      if (decision.always) hooks.enableAuto()
    }
    try {
      const output = await tool.run(parsed.data, {
        workspace: session.workspace,
        signal: run.controller.signal,
        askUser: hooks.askUser,
        updatePlan: hooks.updatePlan,
        search: hooks.search,
        urlAllowed: hooks.urlAllowed,
      })
      return { id: call.id, output, isError: false }
    } catch (error) {
      const message = error instanceof ToolError ? error.message : describeError(error)
      return { id: call.id, output: message, isError: true }
    }
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError || error instanceof OpenAI.AuthenticationError) {
    return 'the provider rejected the API key for this profile'
  }
  if (error instanceof Anthropic.RateLimitError || error instanceof OpenAI.RateLimitError) {
    return 'the provider is rate limiting this account; try again shortly'
  }
  if (error instanceof Anthropic.NotFoundError || error instanceof OpenAI.NotFoundError) {
    return `the provider does not know this model or endpoint: ${error.message}`
  }
  if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
    return `provider error${error.status ? ` ${error.status}` : ''}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}
