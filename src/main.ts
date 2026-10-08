#!/usr/bin/env node
import { createRequire } from 'module'
import {
  execCommand,
  listConversationsCommand,
  listLocalCommand,
  listModelsCommand,
  loginCommand,
  logoutCommand,
  openCommand,
  openConversationCommand,
  setModelCommand,
  setTrainingCommand,
  statusCommand,
  webLoginCommand,
} from './commands'
import { defaultHttp, HttpClient } from './http'
import { CODEFORGE_CLIENT_VERSION } from './client'
import { CODEFORGE_BRAND, codeforgeProductSurfaces } from './logo'
import { DEFAULT_API_BASE } from './store'
import { defaultTuiIo, runTui } from './tui'
import { fetchLatestVersion, formatUpdateNotice, installNpmPackage, maybeLatestUpdate, runUpdate } from './update'
import { findInstallSources } from './updateSources'

const req = createRequire(__filename)

export type InstallPagerResult = {
  ok: boolean
  dest?: string
  skipped?: boolean
  reason?: string
  url?: string
}

export type InstallPager = (options?: { force?: boolean }) => Promise<InstallPagerResult>

function defaultInstallPager(options?: { force?: boolean }): Promise<InstallPagerResult> {
  const { installPager } = req('../scripts/install-pager.js') as { installPager: InstallPager }
  return installPager(options)
}

export function helpText(): string {
  return `${codeforgeProductSurfaces().helpAbout}

One login. Cloud quota. Local workspace.

Install:
  npm install -g @realsteve-afk/codeforge-cli

Usage:
  codeforge login                  open a browser (or print a URL) to sign in
  codeforge login --code <grant>   paste the grant code from the approve page
  codeforge login --email <email> --password <password> [--api <url>]
  codeforge login --token <jwt> [--api <url>]
  codeforge logout
  codeforge status
  codeforge update                 upgrade CLI to latest and reinstall the pager
  codeforge open <dir> --project <project-id>
  codeforge ls [--project <project-id>]
  codeforge exec "<prompt>" [--project <id>] [--model <name>] [--new] [--stub]
  codeforge -p "<prompt>"          headless local-agent turn (alias of exec)
  codeforge models
  codeforge model <name>
  codeforge history
  codeforge thread <conversation-id>
  codeforge training --on|--off
  codeforge                 interactive TUI (CodeForge · Forge ahead.)
  codeforge --resume <id>          reopen a local pager session
  codeforge --version
  codeforge help

Auth and workspaces live in $CODEFORGE_HOME (default ~/.codeforge), shared with Desktop.
Models come from GET /api/runtime/v1/models (CodeForge-Lite / Pro / Ultra).
`
}

function printHelp(): void {
  process.stdout.write(helpText())
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  return args[index + 1]
}

export function pagerResumeArgs(argv: string[]): string[] {
  const [command, ...args] = argv
  if (command === '--resume') {
    return args[0] && !args[0].startsWith('-') ? ['--resume', args[0]] : ['--resume']
  }
  if (command && command !== 'tui') return []
  const index = args.indexOf('--resume')
  if (index === -1) return []
  const id = args[index + 1]
  return id && !id.startsWith('-') ? ['--resume', id] : ['--resume']
}

function parseArgs(args: string[]): { flags: Record<string, string>; rest: string[]; switches: Set<string> } {
  const flags: Record<string, string> = {}
  const rest: string[] = []
  const switches = new Set<string>()
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i]
    if (item === '--new' || item === '--stub' || item === '-p' || item === '--print') {
      switches.add(item.replace(/^-+/, ''))
      continue
    }
    if (item.startsWith('--')) {
      flags[item] = args[i + 1] || ''
      i += 1
      continue
    }
    rest.push(item)
  }
  return { flags, rest, switches }
}

export async function runCli(
  argv: string[],
  deps: {
    http?: HttpClient
    installPager?: InstallPager
    fetchLatest?: () => Promise<string>
    installPackage?: (version: string) => Promise<void> | void
  } = {},
): Promise<number> {
  const http = deps.http ?? defaultHttp
  const [command, ...args] = argv
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return 0
  }
  if (command === '--version' || command === '-V' || command === 'version') {
    process.stdout.write(`codeforge ${CODEFORGE_CLIENT_VERSION} — ${CODEFORGE_BRAND.en} · ${CODEFORGE_BRAND.headline}\n`)
    return 0
  }
  if (!command || command === 'tui' || command === '--resume') {
    const latest = await maybeLatestUpdate({
      fetchLatest: deps.fetchLatest ?? (() => fetchLatestVersion(http)),
    })
    if (latest) {
      process.env.CODEFORGE_UPDATE_AVAILABLE = latest
      const notice = formatUpdateNotice(CODEFORGE_CLIENT_VERSION, latest)
      if (notice) process.stderr.write(notice)
    }
    return runTui(defaultTuiIo(), { pagerArgs: pagerResumeArgs(argv) })
  }
  if (command === 'update') {
    return runUpdate({
      fetchLatest: deps.fetchLatest ?? (() => fetchLatestVersion(http)),
      installPackage: deps.installPackage ?? ((version) => installNpmPackage(version)),
      installPager: deps.installPager ?? defaultInstallPager,
      write: (text) => {
        process.stdout.write(text)
      },
      writeErr: (text) => {
        process.stderr.write(text)
      },
      checkDrift: () => findInstallSources(),
    })
  }
  if (command === 'status') {
    process.stdout.write(`${await statusCommand(defaultHttp)}\n`)
    return 0
  }
  if (command === 'logout') {
    logoutCommand()
    process.stdout.write('logged out\n')
    return 0
  }
  if (command === 'login') {
    const email = flag(args, '--email') || process.env.CODEFORGE_EMAIL || ''
    const password = flag(args, '--password') || process.env.CODEFORGE_PASSWORD || ''
    const token = flag(args, '--token') || process.env.CODEFORGE_TOKEN || ''
    const grantCode = flag(args, '--code') || ''
    const apiBase = flag(args, '--api') || process.env.CODEFORGE_API_BASE || DEFAULT_API_BASE
    const loggedIn = grantCode
      ? await webLoginCommand({
        apiBase,
        grantCode,
        openBrowser: deps.http ? () => undefined : undefined,
      }, http)
      : (email && password) || token
        ? await loginCommand({ email, password, token, apiBase }, http)
        : await webLoginCommand({
          apiBase,
          openBrowser: deps.http ? () => undefined : undefined,
          onStart: (info) => {
            process.stdout.write(`Open ${info.verification_uri_complete}\n`)
            process.stdout.write(`Confirm code ${info.user_code} (or paste --code from the page)\n`)
          },
        }, http)
    process.stdout.write(`logged in as ${loggedIn}\n`)
    process.stdout.write(`${await statusCommand(http)}\n`)
    return 0
  }
  if (command === 'open') {
    const dir = args.find((item) => !item.startsWith('--')) || '.'
    const projectId = flag(args, '--project') || ''
    if (!projectId) {
      process.stderr.write('codeforge open requires --project <project-id>\n')
      return 2
    }
    process.stdout.write(`${openCommand(projectId, dir)}\n`)
    return 0
  }
  if (command === 'ls') {
    process.stdout.write(`${listLocalCommand(flag(args, '--project'))}\n`)
    return 0
  }
  if (command === 'exec' || command === '-p' || command === '--print') {
    const parsed = parseArgs(args)
    const prompt = parsed.rest.join(' ').trim()
    if (!prompt) {
      process.stderr.write('codeforge exec requires a prompt\n')
      return 2
    }
    const result = await execCommand(prompt, {
      projectId: parsed.flags['--project'],
      model: parsed.flags['--model'],
      newConversation: parsed.switches.has('new'),
      stub: parsed.switches.has('stub') || process.env.CODEFORGE_RUNTIME_STUB === '1',
    }, http)
    if (result.text.trim()) {
      process.stdout.write(`${result.text}\n`)
      return 0
    }
    process.stderr.write('no model text\n')
    return 1
  }
  if (command === 'history') {
    process.stdout.write(`${await listConversationsCommand(http)}\n`)
    return 0
  }
  if (command === 'thread') {
    const id = args.find((item) => !item.startsWith('--')) || ''
    process.stdout.write(`${await openConversationCommand(id, http)}\n`)
    return 0
  }
  if (command === 'models') {
    process.stdout.write(`${await listModelsCommand(http)}\n`)
    return 0
  }
  if (command === 'model') {
    const name = args.find((item) => !item.startsWith('--')) || ''
    process.stdout.write(`${await setModelCommand(name, http)}\n`)
    return 0
  }
  if (command === 'training') {
    if (args.includes('--on')) {
      process.stdout.write(`${await setTrainingCommand(true)}\n`)
      return 0
    }
    if (args.includes('--off')) {
      process.stdout.write(`${await setTrainingCommand(false)}\n`)
      return 0
    }
    process.stderr.write('codeforge training requires --on or --off\n')
    return 2
  }
  process.stderr.write(`unknown command: ${command}\n`)
  printHelp()
  return 2
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
