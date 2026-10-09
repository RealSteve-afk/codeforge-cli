import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { ApiError, HarnessClient, type SessionView } from '../client/api'
import type { AgentEvent } from '../core/providers/types'
import type { PublicProfile, PublicUser, TranscriptItem, WebHit } from '../core/store'
import type { PlanItem } from '../core/tools'

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[39m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[39m`,
}

interface TuiConfig {
  token?: string
  defaultProfileId?: string
  lastSessionId?: string
}

const HELP = `
${c.bold('Chat')}       type a message and press Enter. Ctrl+C cancels a running turn.
${c.bold('Sessions')}   /new [workspace-dir]   /sessions   /open <number|id>   /rename <title>   /delete
${c.bold('Models')}     /model (pick from a list)   /model <profile> <model>   /models [profile]
${c.bold('Web')}        /web on | off   (let the agent search and read the web)
${c.bold('Progress')}   /status (what the agent is doing right now)   Ctrl+C stops a running turn
${c.bold('Approvals')}  /mode ask | auto   (ask = approve every file change and command)
${c.bold('Profiles')}   /profiles   /profile add   /profile rm <name>   /use <profile name>
${c.bold('Account')}    /whoami   /logout   /users   /user add   (admin)
${c.bold('Other')}      /gui (show the web GUI address)   /help   /quit
`

export class Tui {
  private readonly rl: readline.Interface
  private muted = false
  private user?: PublicUser
  private session?: SessionView
  private running = false
  private activity = { text: '', started: 0, steps: 0, plan: '' }
  private config: TuiConfig

  constructor(
    private readonly client: HarnessClient,
    private readonly configFile: string,
    private readonly guiUrl: string,
  ) {
    this.config = readConfig(configFile)
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
    const rlAny = this.rl as unknown as { _writeToOutput: (s: string) => void }
    const write = rlAny._writeToOutput.bind(this.rl)
    rlAny._writeToOutput = (s: string) => {
      if (!this.muted) write(s)
      else if (/[\r\n]/.test(s)) process.stdout.write('\n')
    }
    this.rl.on('SIGINT', () => {
      if (this.running && this.session) {
        process.stdout.write(c.yellow('\n⏹  cancelling…\n'))
        void this.client.cancel(this.session.id).catch(() => undefined)
      } else {
        this.quit()
      }
    })
  }

  private ask(question: string, options: { hidden?: boolean; fallback?: string } = {}): Promise<string> {
    const suffix = options.fallback ? c.dim(` [${options.fallback}]`) : ''
    return new Promise((resolve) => {
      this.rl.question(`${question}${suffix}: `, (answer) => {
        this.muted = false
        resolve(answer.trim() || options.fallback || '')
      })
      if (options.hidden) this.muted = true
    })
  }

  private saveConfig(): void {
    fs.mkdirSync(path.dirname(this.configFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(this.configFile, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 })
  }

  async start(): Promise<void> {
    process.stdout.write(`${c.bold(c.magenta('◆ Forge Harness'))} ${c.dim('— multi-account LLM agent · /help for commands')}\n`)
    await this.authenticate()
    await this.ensureProfile()
    await this.resumeOrCreate()
    this.loop()
  }

  private async authenticate(): Promise<void> {
    if (await this.client.needsSetup()) {
      process.stdout.write(`${c.cyan('First run: create the admin account.')}\n`)
      for (;;) {
        try {
          const username = await this.ask('Admin username', { fallback: 'admin' })
          const password = await this.ask('Password (8+ characters)', { hidden: true })
          const result = await this.client.setup(username, password)
          return this.loggedIn(result.token, result.user)
        } catch (error) {
          process.stdout.write(c.red(`${(error as Error).message}\n`))
        }
      }
    }
    if (this.config.token) {
      this.client.token = this.config.token
      try {
        return this.loggedIn(this.config.token, await this.client.me())
      } catch {
        this.client.token = ''
      }
    }
    for (;;) {
      try {
        const username = await this.ask('Username')
        const password = await this.ask('Password', { hidden: true })
        const result = await this.client.login(username, password)
        return this.loggedIn(result.token, result.user)
      } catch (error) {
        process.stdout.write(c.red(`${(error as Error).message}\n`))
      }
    }
  }

  private loggedIn(token: string, user: PublicUser): void {
    this.client.token = token
    this.user = user
    this.config.token = token
    this.saveConfig()
    process.stdout.write(c.green(`Signed in as ${user.username}${user.isAdmin ? ' (admin)' : ''}\n`))
  }

  private async ensureProfile(): Promise<void> {
    const profiles = await this.client.profiles()
    if (profiles.length) return
    process.stdout.write(c.cyan('You have no provider profiles yet. Let’s add one.\n'))
    await this.addProfile()
  }

  private async addProfile(): Promise<PublicProfile | undefined> {
    process.stdout.write(`  1) Anthropic (Claude)\n  2) OpenAI or OpenAI-compatible (Ollama, OpenRouter, vLLM, LM Studio…)\n`)
    const choice = await this.ask('Provider', { fallback: '1' })
    try {
      let profile: PublicProfile
      if (choice === '2') {
        const name = await this.ask('Profile name', { fallback: 'openai' })
        const baseUrl = await this.ask('Base URL (blank = api.openai.com, e.g. http://localhost:11434/v1 for Ollama)')
        const model = await this.ask('Model id')
        const apiKey = await this.ask('API key (blank for local servers)', { hidden: true })
        profile = await this.client.createProfile({ name, provider: 'openai', baseUrl, model, apiKey })
      } else {
        const name = await this.ask('Profile name', { fallback: 'claude' })
        const model = await this.ask('Model', { fallback: 'claude-opus-5-5' })
        const apiKey = await this.ask('Anthropic API key', { hidden: true })
        const effort = await this.ask('Effort (low, medium, high, xhigh, max)', { fallback: 'high' })
        profile = await this.client.createProfile({ name, provider: 'anthropic', model, apiKey, effort })
      }
      this.config.defaultProfileId ??= profile.id
      this.saveConfig()
      process.stdout.write(c.green(`Added profile "${profile.name}" (${profile.provider} · ${profile.model})\n`))
      return profile
    } catch (error) {
      process.stdout.write(c.red(`${(error as Error).message}\n`))
      return undefined
    }
  }

  private async defaultProfile(): Promise<PublicProfile | undefined> {
    const profiles = await this.client.profiles()
    return profiles.find((p) => p.id === this.config.defaultProfileId) ?? profiles[0]
  }

  private async resumeOrCreate(): Promise<void> {
    if (this.config.lastSessionId) {
      try {
        await this.openSession(this.config.lastSessionId)
        return
      } catch {
        // the session was deleted; start a new one
      }
    }
    await this.newSession()
  }

  private async newSession(workspace?: string): Promise<void> {
    const profile = await this.defaultProfile()
    if (!profile) {
      process.stdout.write(c.red('add a profile first: /profile add\n'))
      return
    }
    const dir = workspace ? path.resolve(workspace) : this.user?.isAdmin ? process.cwd() : undefined
    const session = await this.client.createSession({ profileId: profile.id, workspace: dir })
    await this.openSession(session.id)
  }

  private async openSession(id: string): Promise<void> {
    const session = await this.client.session(id)
    this.session = session
    this.config.lastSessionId = session.id
    this.saveConfig()
    const profiles = await this.client.profiles()
    const profile = profiles.find((p) => p.id === session.profileId)
    process.stdout.write(
      `\n${c.bold(session.title)} ${c.dim(`· ${profile?.name ?? 'missing profile'} · ${session.model} · ${session.mode} mode · web ${session.web === false ? 'off' : 'on'}`)}\n${c.dim(`workspace ${session.workspace}`)}\n`,
    )
    for (const item of session.transcript.slice(-30)) this.renderTranscript(item)
    if (session.running) await this.consume(this.client.attach(session.id))
  }

  private renderTranscript(item: TranscriptItem): void {
    switch (item.kind) {
      case 'user':
        process.stdout.write(`\n${c.bold(c.cyan('you ›'))} ${item.text}\n`)
        break
      case 'text':
        process.stdout.write(`${item.text}\n`)
        break
      case 'thinking':
        process.stdout.write(c.dim(`✻ ${item.text.slice(0, 300)}${item.text.length > 300 ? '…' : ''}\n`))
        break
      case 'tool_call':
        process.stdout.write(c.yellow(`⏺ ${item.name}(${summarizeInput(item.input)})\n`))
        break
      case 'tool_result':
        process.stdout.write(formatResult(item.output, item.isError))
        break
      case 'notice':
        process.stdout.write(c.magenta(`• ${item.text}\n`))
        break
      case 'error':
        process.stdout.write(c.red(`✖ ${item.text}\n`))
        break
      case 'progress':
        process.stdout.write(c.dim(`▸ ${item.text.trim()}\n`))
        break
      case 'web':
        process.stdout.write(formatWeb(item.action, item.query ?? item.url ?? ''))
        if (item.results || item.error) process.stdout.write(formatWebResults(item.results, item.error))
        break
      case 'plan':
        process.stdout.write(formatPlan(item.items))
        break
      case 'question':
        process.stdout.write(c.cyan(`❓ ${item.question}\n`) + c.dim(`  → ${item.answer ?? 'no answer'}\n`))
        break
      case 'summary':
        process.stdout.write(c.dim(`${formatSummary(item)}\n`))
        break
    }
  }

  private loop(): void {
    this.rl.setPrompt(c.bold(c.cyan('› ')))
    this.rl.prompt()
    this.rl.on('line', (line) => {
      if (this.muted) return
      void this.onLine(line.trim()).finally(() => {
        if (!this.running) this.rl.prompt()
      })
    })
  }

  private async onLine(line: string): Promise<void> {
    if (!line) return
    try {
      if (this.running && !line.startsWith('/')) {
        process.stdout.write(c.dim('\n(a turn is running — /status shows what it is doing, Ctrl+C stops it)\n'))
        return
      }
      if (line.startsWith('/')) await this.command(line)
      else await this.sendMessage(line)
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0
      if (status === 401) process.stdout.write(c.red('your login expired; restart and sign in again\n'))
      else process.stdout.write(c.red(`${(error as Error).message}\n`))
    }
  }

  private async sendMessage(text: string): Promise<void> {
    if (!this.session) {
      process.stdout.write(c.red('no session open: /new\n'))
      return
    }
    await this.consume(this.client.send(this.session.id, text))
  }

  private async consume(events: AsyncGenerator<AgentEvent>): Promise<void> {
    this.running = true
    this.activity = { text: 'Starting…', started: Date.now(), steps: 0, plan: '' }
    setTitle('● Forge Harness — working')
    let mode: 'text' | 'thinking' | 'progress' | 'none' = 'none'
    const startBlock = (next: 'text' | 'thinking' | 'progress') => {
      if (mode !== next) {
        process.stdout.write(next === 'thinking' ? c.dim('\n✻ ') : next === 'progress' ? c.dim('\n▸ ') : '\n')
        mode = next
      }
    }
    const hidden = new Set<string>()
    try {
      for await (const event of events) {
        this.track(event)
        switch (event.type) {
          case 'thinking':
            startBlock('thinking')
            process.stdout.write(c.dim(event.text))
            break
          case 'progress':
            startBlock('progress')
            process.stdout.write(c.dim(event.text))
            break
          case 'text':
            startBlock('text')
            process.stdout.write(event.text)
            break
          case 'tool_call':
            mode = 'none'
            if (event.name === 'update_plan' || event.name === 'ask_user') {
              hidden.add(event.id)
              break
            }
            if (event.name === 'web_search' || event.name === 'web_fetch') {
              const input = (event.input ?? {}) as { query?: string; url?: string }
              process.stdout.write(`\n${formatWeb(event.name === 'web_search' ? 'search' : 'fetch', input.query ?? input.url ?? '')}`)
              break
            }
            process.stdout.write(c.yellow(`\n⏺ ${event.name}(${summarizeInput(event.input)})\n`))
            break
          case 'tool_result':
            if (!hidden.has(event.id)) process.stdout.write(formatResult(event.output, event.isError))
            break
          case 'web':
            mode = 'none'
            process.stdout.write(`\n${formatWeb(event.action, event.query ?? event.url ?? '')}`)
            break
          case 'web_result':
            process.stdout.write(formatWebResults(event.results, event.error, event.title ?? event.url))
            break
          case 'plan':
            mode = 'none'
            process.stdout.write(`\n${formatPlan(event.items)}`)
            break
          case 'question': {
            mode = 'none'
            process.stdout.write(`\x07\n${c.cyan(c.bold(`❓ ${event.question}`))}\n`)
            event.options.forEach((option, i) => process.stdout.write(`  ${c.bold(String(i + 1))}) ${option}\n`))
            const raw = await this.ask(event.options.length ? '  Your answer (number or text)' : '  Your answer')
            const answer = /^\d+$/.test(raw) && event.options[Number(raw) - 1] ? event.options[Number(raw) - 1] : raw
            await this.client.answer(this.session!.id, event.questionId, answer)
            break
          }
          case 'approval': {
            process.stdout.write('\x07')
            const answer = (await this.ask(c.yellow(`  Allow ${event.name}? [y]es / [n]o / [a]lways for this session`), { fallback: 'y' })).toLowerCase()
            const allow = answer.startsWith('y') || answer.startsWith('a')
            await this.client.approve(this.session!.id, event.approvalId, allow, answer.startsWith('a'))
            break
          }
          case 'notice':
            mode = 'none'
            process.stdout.write(c.magenta(`\n• ${event.text}\n`))
            break
          case 'error':
            mode = 'none'
            process.stdout.write(c.red(`\n✖ ${event.message}\n`))
            break
          case 'summary':
            process.stdout.write(c.dim(`\n${formatSummary(event)}\n`))
            break
          case 'status':
          case 'usage':
          case 'done':
            break
        }
      }
    } finally {
      this.running = false
      setTitle('Forge Harness')
      if (this.session) this.session = await this.client.session(this.session.id).catch(() => this.session)
    }
  }

  // Keeps a one-line description of the current activity for /status.
  private track(event: AgentEvent): void {
    const a = this.activity
    switch (event.type) {
      case 'thinking': a.text = 'thinking'; break
      case 'progress': a.text = event.text.trim().split('\n')[0] || a.text; break
      case 'text': a.text = 'writing the answer'; break
      case 'status': a.text = event.text; break
      case 'tool_call': a.steps += 1; a.text = `running ${event.name} ${summarizeInput(event.input)}`; break
      case 'web': a.steps += 1; a.text = event.action === 'search' ? `searching the web for “${event.query ?? ''}”` : `reading ${event.url ?? 'a page'}`; break
      case 'approval': a.text = `waiting for your approval (${event.name})`; break
      case 'question': a.text = 'waiting for your answer'; break
      case 'plan': {
        const done = event.items.filter((i) => i.status === 'done').length
        const current = event.items.find((i) => i.status === 'in_progress')
        a.plan = `plan ${done}/${event.items.length}${current ? ` — now: ${current.text}` : ''}`
        break
      }
    }
  }

  private printStatus(): void {
    if (!this.running) {
      process.stdout.write('idle — nothing is running\n')
      return
    }
    const seconds = Math.round((Date.now() - this.activity.started) / 1000)
    process.stdout.write(
      c.cyan(`⏳ ${this.activity.text} · ${formatDuration(seconds)} · ${this.activity.steps} steps${this.activity.plan ? ` · ${this.activity.plan}` : ''}\n`),
    )
  }

  private async pickModel(args: string[]): Promise<void> {
    if (!this.session) throw new Error('no session open')
    const profiles = await this.client.profiles()
    let profile: PublicProfile | undefined
    let model: string | undefined
    if (args.length) {
      profile = profiles.find((p) => p.name === args[0])
      if (profile) model = args[1]
      else {
        profile = profiles.find((p) => p.id === this.session!.profileId)
        model = args[0]
      }
      if (!profile) throw new Error('no such profile; see /profiles')
    } else {
      profiles.forEach((p, i) => process.stdout.write(`  ${c.bold(String(i + 1))}) ${p.name} ${c.dim(`${p.provider} · default ${p.model}`)}\n`))
      const pick = profiles[Number(await this.ask('Profile number', { fallback: String(profiles.findIndex((p) => p.id === this.session!.profileId) + 1) })) - 1]
      if (!pick) throw new Error('no such profile')
      profile = pick
      const { models, error } = await this.client.models(pick.id)
      const ids = Array.from(new Set([pick.model, ...models]))
      ids.slice(0, 40).forEach((id, i) => process.stdout.write(`  ${c.bold(String(i + 1).padStart(2))}) ${id}${id === this.session!.model ? c.green(' ●') : ''}\n`))
      if (ids.length > 40) process.stdout.write(c.dim(`  … ${ids.length - 40} more; type a model id to use one of them\n`))
      if (error) process.stdout.write(c.dim(`  (${error})\n`))
      const raw = await this.ask('Model number or id', { fallback: '1' })
      model = /^\d+$/.test(raw) ? ids[Number(raw) - 1] : raw
    }
    const updated = await this.client.switchModel(this.session.id, profile.id, model)
    this.session = { ...this.session, ...updated }
    process.stdout.write(c.green(`now using ${profile.name} · ${updated.model}\n`))
  }

  private async command(line: string): Promise<void> {
    const [cmd, ...args] = line.slice(1).split(/\s+/)
    const rest = args.join(' ')
    switch (cmd) {
      case 'help':
        process.stdout.write(HELP)
        return
      case 'quit':
      case 'exit':
        return this.quit()
      case 'gui':
        process.stdout.write(`Web GUI: ${c.bold(this.guiUrl)}\n`)
        return
      case 'whoami':
        process.stdout.write(`${this.user?.username}${this.user?.isAdmin ? ' (admin)' : ''} · workspaces: ${this.user?.workspaceRoots.join(', ')}\n`)
        return
      case 'logout':
        await this.client.logout().catch(() => undefined)
        delete this.config.token
        this.saveConfig()
        process.stdout.write('logged out\n')
        return this.quit()
      case 'new':
        return this.newSession(rest || undefined)
      case 'sessions': {
        const sessions = await this.client.sessions()
        sessions.forEach((s, i) =>
          process.stdout.write(`${String(i + 1).padStart(3)}. ${s.id === this.session?.id ? c.green('●') : ' '} ${s.title} ${c.dim(`· ${s.model} · ${s.updatedAt.slice(0, 16).replace('T', ' ')}${s.running ? ' · running' : ''}`)}\n`),
        )
        if (!sessions.length) process.stdout.write('no sessions yet\n')
        return
      }
      case 'open': {
        const sessions = await this.client.sessions()
        const pick = /^\d+$/.test(rest) ? sessions[Number(rest) - 1] : sessions.find((s) => s.id === rest)
        if (!pick) throw new Error('no such session; see /sessions')
        return this.openSession(pick.id)
      }
      case 'rename':
        if (!this.session || !rest) throw new Error('usage: /rename <title>')
        this.session = { ...this.session, ...(await this.client.updateSession(this.session.id, { title: rest })) }
        process.stdout.write(`renamed to ${rest}\n`)
        return
      case 'delete':
        if (!this.session) return
        if ((await this.ask(`Delete "${this.session.title}"? (y/N)`)).toLowerCase() !== 'y') return
        await this.client.deleteSession(this.session.id)
        delete this.config.lastSessionId
        this.session = undefined
        return this.newSession()
      case 'status':
        this.printStatus()
        return
      case 'model':
        return this.pickModel(args)
      case 'models': {
        const profiles = await this.client.profiles()
        const targets = rest ? profiles.filter((p) => p.name === rest) : profiles
        if (!targets.length) throw new Error('no such profile; see /profiles')
        for (const p of targets) {
          const { models, error } = await this.client.models(p.id)
          process.stdout.write(`${c.bold(p.name)} ${c.dim(p.provider)}\n${models.length ? models.map((m) => `  ${m}`).join('\n') : c.dim(`  ${error ?? 'no models listed'}`)}\n`)
        }
        return
      }
      case 'web':
        if (!this.session || (rest !== 'on' && rest !== 'off')) throw new Error('usage: /web on | off')
        this.session = { ...this.session, ...(await this.client.updateSession(this.session.id, { web: rest === 'on' })) }
        process.stdout.write(`web access ${rest}\n`)
        return
      case 'mode':
        if (!this.session || (rest !== 'ask' && rest !== 'auto')) throw new Error('usage: /mode ask | auto')
        this.session = { ...this.session, ...(await this.client.updateSession(this.session.id, { mode: rest })) }
        process.stdout.write(`approval mode: ${rest}\n`)
        return
      case 'profiles': {
        const profiles = await this.client.profiles()
        for (const p of profiles) {
          const mark = p.id === this.config.defaultProfileId ? c.green('★') : ' '
          process.stdout.write(`${mark} ${c.bold(p.name)} ${c.dim(`${p.provider} · ${p.model}${p.baseUrl ? ` · ${p.baseUrl}` : ''}${p.apiKeyHint ? ` · key ${p.apiKeyHint}` : ''}`)}\n`)
        }
        if (!profiles.length) process.stdout.write('no profiles: /profile add\n')
        return
      }
      case 'profile':
        if (args[0] === 'add') {
          await this.addProfile()
          return
        }
        if (args[0] === 'rm' && args[1]) {
          const profile = (await this.client.profiles()).find((p) => p.name === args.slice(1).join(' '))
          if (!profile) throw new Error('no profile with that name')
          await this.client.deleteProfile(profile.id)
          process.stdout.write(`removed ${profile.name}\n`)
          return
        }
        throw new Error('usage: /profile add | /profile rm <name>')
      case 'use': {
        const profile = (await this.client.profiles()).find((p) => p.name === rest)
        if (!profile) throw new Error('no profile with that name; see /profiles')
        this.config.defaultProfileId = profile.id
        this.saveConfig()
        process.stdout.write(`new sessions will use ${profile.name}. Start one with /new\n`)
        return
      }
      case 'users': {
        for (const u of await this.client.users()) {
          process.stdout.write(`${u.username}${u.isAdmin ? c.yellow(' admin') : ''} ${c.dim(u.workspaceRoots.join(', '))}\n`)
        }
        return
      }
      case 'user':
        if (args[0] === 'add') {
          const username = await this.ask('New username')
          const password = await this.ask('Password (8+ characters)', { hidden: true })
          const isAdmin = (await this.ask('Admin? (y/N)')).toLowerCase() === 'y'
          const roots = await this.ask('Workspace directories, comma separated (blank = a private folder)')
          const user = await this.client.createUser({
            username,
            password,
            isAdmin,
            workspaceRoots: roots ? roots.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          })
          process.stdout.write(c.green(`created ${user.username}\n`))
          return
        }
        throw new Error('usage: /user add')
      default:
        throw new Error(`unknown command /${cmd}; see /help`)
    }
  }

  private quit(): never {
    this.rl.close()
    process.stdout.write('\n')
    process.exit(0)
  }
}

function setTitle(title: string): void {
  if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${title}\x07`)
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  return m ? `${m}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
}

function formatWeb(action: 'search' | 'fetch', target: string): string {
  return c.blue(action === 'search' ? `🔎 searching the web: “${target}”\n` : `🌐 reading ${target}\n`)
}

function formatWebResults(results?: WebHit[], error?: string, page?: string): string {
  if (error) return c.red(`  ⎿ ${error}\n`)
  if (results) return results.slice(0, 5).map((r) => c.dim(`  ⎿ ${r.title ? `${r.title} — ` : ''}${r.url}\n`)).join('') || c.dim('  ⎿ no results\n')
  return page ? c.dim(`  ⎿ ${page}\n`) : ''
}

function formatPlan(items: PlanItem[]): string {
  const done = items.filter((i) => i.status === 'done').length
  const lines = items.map((i) => {
    const mark = i.status === 'done' ? c.green('✔') : i.status === 'in_progress' ? c.yellow('▶') : c.dim('○')
    const text = i.status === 'done' ? c.dim(i.text) : i.status === 'in_progress' ? c.bold(i.text) : i.text
    return `  ${mark} ${text}`
  })
  return `${c.bold(`📋 Plan ${done}/${items.length}`)}\n${lines.join('\n')}\n`
}

function formatSummary(s: { seconds: number; steps: number; stopReason: string; inputTokens: number; outputTokens: number }): string {
  const icon = s.stopReason === 'cancelled' ? '⏹' : s.stopReason === 'error' || s.stopReason === 'refusal' ? '⚠' : '✓'
  const tokens = s.inputTokens || s.outputTokens ? ` · ${s.inputTokens} in / ${s.outputTokens} out tokens` : ''
  return `${icon} ${s.stopReason === 'cancelled' ? 'stopped' : 'finished'} in ${formatDuration(s.seconds)} · ${s.steps} steps${tokens}`
}

function readConfig(file: string): TuiConfig {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as TuiConfig
  } catch {
    return {}
  }
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  return Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      const short = text.length > 60 ? `${text.slice(0, 57).replace(/\n/g, '⏎')}…` : text.replace(/\n/g, '⏎')
      return `${key}=${short}`
    })
    .join(', ')
}

function formatResult(output: string, isError: boolean): string {
  const lines = output.split('\n')
  const shown = lines.slice(0, 6).map((line) => `  ⎿ ${line.slice(0, 160)}`)
  if (lines.length > 6) shown.push(`  ⎿ … ${lines.length - 6} more lines`)
  const text = `${shown.join('\n')}\n`
  return isError ? c.red(text) : c.dim(text)
}
