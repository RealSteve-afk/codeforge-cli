import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import os from 'os'
import { randomToken } from './crypto'
import { anthropicProvider } from './providers/anthropic'
import { openaiProvider } from './providers/openai'
import type { AgentEvent, Provider, ToolCall, ToolOutcome } from './providers/types'
import { type PublicProfile, type PublicUser, type Session, type Store, type TranscriptItem, UserError } from './store'
import { findTool, TOOLS, ToolError } from './tools'

export type ProviderFactory = (profile: PublicProfile, apiKey: string | undefined) => Provider

export const defaultProviderFactory: ProviderFactory = (profile, apiKey) =>
  profile.provider === 'anthropic'
    ? anthropicProvider({
        apiKey: apiKey ?? '',
        model: profile.model,
        baseUrl: profile.baseUrl,
        effort: profile.effort,
        thinking: profile.thinking,
        fallbacks: profile.fallbacks,
      })
    : openaiProvider({ apiKey, model: profile.model, baseUrl: profile.baseUrl, effort: profile.effort })

type Listener = (event: AgentEvent) => void

// One in-flight turn. Clients can attach at any time; they get a replay of the
// turn's events so far, then live events.
export class Run {
  readonly id = `run_${randomToken(9)}`
  readonly events: AgentEvent[] = []
  readonly controller = new AbortController()
  readonly approvals = new Map<string, (decision: { allow: boolean; always: boolean }) => void>()
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
    'When you finish, reply with a short summary of what you did and anything left for the user to decide.',
  ].join('\n')
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

  start(user: PublicUser, sessionId: string, text: string): Run {
    const prompt = text.trim()
    if (!prompt) throw new UserError('message is empty')
    const session = this.store.getSession(user.id, sessionId)
    if (this.runs.get(sessionId) && !this.runs.get(sessionId)!.done) throw new UserError('this session is already running a turn')
    const profile = this.store.getProfile(user.id, session.profileId)
    const apiKey = this.store.profileApiKey(user.id, session.profileId)
    const run = new Run(sessionId, user.id)
    this.runs.set(sessionId, run)
    void this.execute(run, session, profile, apiKey, prompt)
    return run
  }

  resolveApproval(userId: string, sessionId: string, approvalId: string, allow: boolean, always = false): void {
    const run = this.activeRun(userId, sessionId)
    const resolve = run?.approvals.get(approvalId)
    if (!run || !resolve) throw new UserError('no pending approval with that id')
    run.approvals.delete(approvalId)
    resolve({ allow, always })
  }

  cancel(userId: string, sessionId: string): boolean {
    const run = this.activeRun(userId, sessionId)
    if (!run || run.done) return false
    run.controller.abort()
    for (const [id, resolve] of run.approvals) {
      run.approvals.delete(id)
      resolve({ allow: false, always: false })
    }
    return true
  }

  private async execute(run: Run, session: Session, profile: PublicProfile, apiKey: string | undefined, prompt: string): Promise<void> {
    const transcript: TranscriptItem[] = [{ kind: 'user', text: prompt, at: new Date().toISOString() }]
    const usage = { inputTokens: 0, outputTokens: 0 }
    const history = [...session.history]
    let committed = history.length
    const title = session.title === 'New session' ? prompt.replace(/\s+/g, ' ').slice(0, 60) : session.title
    let autoApprove = session.mode === 'auto'

    const record = (event: AgentEvent): void => {
      const last = transcript[transcript.length - 1]
      switch (event.type) {
        case 'text':
        case 'thinking':
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

    const runTools = async (calls: ToolCall[]): Promise<ToolOutcome[]> => {
      const outcomes: ToolOutcome[] = []
      for (const call of calls) {
        emit({ type: 'tool_call', id: call.id, name: call.name, input: call.input })
        const outcome = await this.runTool(run, session, call, () => autoApprove, () => {
          autoApprove = true
        }, emit)
        emit({ type: 'tool_result', id: call.id, output: outcome.output, isError: outcome.isError })
        outcomes.push(outcome)
      }
      return outcomes
    }

    let stopReason = 'error'
    try {
      const provider = this.providerFactory(profile, apiKey)
      stopReason = await provider.runTurn(prompt, {
        history,
        commit: () => {
          committed = history.length
          persist()
        },
        system: systemPrompt(session),
        tools: TOOLS,
        runTools,
        emit,
        signal: run.controller.signal,
      })
    } catch (error) {
      if (run.controller.signal.aborted) {
        stopReason = 'cancelled'
        emit({ type: 'notice', text: 'turn cancelled' })
      } else {
        emit({ type: 'error', message: describeError(error) })
      }
    } finally {
      persist()
      run.done = true
      run.emit({ type: 'done', stopReason })
    }
  }

  private async runTool(
    run: Run,
    session: Session,
    call: ToolCall,
    isAuto: () => boolean,
    enableAuto: () => void,
    emit: (event: AgentEvent) => void,
  ): Promise<ToolOutcome> {
    const tool = findTool(call.name)
    if (!tool) return { id: call.id, output: `unknown tool "${call.name}"`, isError: true }
    // Streamed tool input is not validated by the API, so check it here before running anything.
    const parsed = tool.schema.safeParse(call.input)
    if (!parsed.success) {
      return { id: call.id, output: JSON.stringify({ INVALID_JSON: JSON.stringify(call.input), issues: parsed.error.issues.map((i) => i.message) }), isError: true }
    }
    if (run.controller.signal.aborted) return { id: call.id, output: 'cancelled by the user', isError: true }
    if (tool.mutates && !isAuto()) {
      const approvalId = `apr_${randomToken(6)}`
      const decision = await new Promise<{ allow: boolean; always: boolean }>((resolve) => {
        run.approvals.set(approvalId, resolve)
        emit({ type: 'approval', approvalId, toolCallId: call.id, name: call.name, input: parsed.data })
      })
      emit({ type: 'approval_resolved', approvalId, allowed: decision.allow })
      if (!decision.allow) return { id: call.id, output: 'the user denied this tool call', isError: true }
      if (decision.always) enableAuto()
    }
    try {
      const output = await tool.run(parsed.data, { workspace: session.workspace, signal: run.controller.signal })
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
  if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
    return `provider error${error.status ? ` ${error.status}` : ''}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}
