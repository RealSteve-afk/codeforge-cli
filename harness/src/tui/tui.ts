import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { ApiError, HarnessClient, type SessionView } from '../client/api'
import type { AgentEvent } from '../core/providers/types'
import type { PublicProfile, PublicUser, TranscriptItem } from '../core/store'

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[39m`,
}

interface TuiConfig {
  token?: string
  defaultProfileId?: string
  lastSessionId?: string
}

const HELP = `
${c.bold('Chat')}       type a message and press Enter. Ctrl+C cancels a running turn.
${c.bold('Sessions')}   /new [workspace-dir]   /sessions   /open <number|id>   /rename <title>   /delete
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
      `\n${c.bold(session.title)} ${c.dim(`· ${profile?.name ?? 'missing profile'} · ${session.model} · ${session.mode} mode`)}\n${c.dim(`workspace ${session.workspace}`)}\n`,
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
    let mode: 'text' | 'thinking' | 'none' = 'none'
    const startBlock = (next: 'text' | 'thinking') => {
      if (mode !== next) {
        process.stdout.write(next === 'thinking' ? c.dim('\n✻ ') : '\n')
        mode = next
      }
    }
    try {
      for await (const event of events) {
        switch (event.type) {
          case 'thinking':
            startBlock('thinking')
            process.stdout.write(c.dim(event.text))
            break
          case 'text':
            startBlock('text')
            process.stdout.write(event.text)
            break
          case 'tool_call':
            mode = 'none'
            process.stdout.write(c.yellow(`\n⏺ ${event.name}(${summarizeInput(event.input)})\n`))
            break
          case 'tool_result':
            process.stdout.write(formatResult(event.output, event.isError))
            break
          case 'approval': {
            const answer = (await this.ask(c.yellow(`  Allow ${event.name}? [y]es / [n]o / [a]lways for this session`), { fallback: 'y' })).toLowerCase()
            const allow = answer.startsWith('y') || answer.startsWith('a')
            await this.client.approve(this.session!.id, event.approvalId, allow, answer.startsWith('a'))
            break
          }
          case 'notice':
            process.stdout.write(c.magenta(`\n• ${event.text}\n`))
            break
          case 'error':
            process.stdout.write(c.red(`\n✖ ${event.message}\n`))
            break
          case 'usage':
            break
          case 'done':
            process.stdout.write(c.dim(`\n— ${event.stopReason}\n`))
            break
        }
      }
    } finally {
      this.running = false
      if (this.session) this.session = await this.client.session(this.session.id).catch(() => this.session)
    }
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
