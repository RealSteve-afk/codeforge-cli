#!/usr/bin/env node
import { spawn } from 'child_process'
import path from 'path'
import readline from 'readline'
import { HarnessClient } from './client/api'
import { defaultDataDir, Store } from './core/store'
import { createServer, listen } from './server/server'
import { Tui } from './tui/tui'

const DEFAULT_PORT = 7878
const DEFAULT_HOST = '127.0.0.1'

const HELP = `Forge Harness — multi-user, multi-provider LLM coding agent

Usage:
  harness                      start the TUI (starts the engine in the background if needed)
  harness tui [--server URL]   same as above, against a specific engine
  harness serve [--port N] [--host H]
                               run only the engine + web GUI (default http://${DEFAULT_HOST}:${DEFAULT_PORT})
  harness gui [--port N]       run the engine and open the web GUI in your browser
  harness user add <name> [--admin]
                               create an account from the command line
  harness help

Data lives in $HARNESS_HOME (default ~/.forge-harness). API keys are encrypted at rest.
`

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

async function startEngine(port: number, host: string): Promise<string> {
  const store = new Store()
  const server = createServer({ store })
  const actual = await listen(server, port, host)
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual}`
}

// Use a running engine if there is one; otherwise start one inside this process.
async function ensureEngine(url: string): Promise<{ url: string; started: boolean }> {
  if (await new HarnessClient(url).ping()) return { url, started: false }
  const parsed = new URL(url)
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error(`cannot reach the engine at ${url}`)
  return { url: await startEngine(Number(parsed.port) || DEFAULT_PORT, DEFAULT_HOST), started: true }
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref()
}

function askHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const rlAny = rl as unknown as { _writeToOutput: (s: string) => void }
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
    rlAny._writeToOutput = () => undefined
  })
}

export async function main(argv: string[]): Promise<number> {
  const [command = 'tui', ...args] = argv
  const port = Number(flag(args, '--port') ?? process.env.HARNESS_PORT ?? DEFAULT_PORT)
  const host = flag(args, '--host') ?? process.env.HARNESS_HOST ?? DEFAULT_HOST

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP)
      return 0
    case 'serve': {
      const url = await startEngine(port, host)
      process.stdout.write(`Forge Harness engine + web GUI on ${url}\n`)
      if (host !== DEFAULT_HOST && host !== 'localhost') {
        process.stdout.write('WARNING: listening beyond localhost. Put it behind HTTPS before exposing it to a network.\n')
      }
      return new Promise<number>(() => undefined)
    }
    case 'gui': {
      const engine = await ensureEngine(`http://${DEFAULT_HOST}:${port}`)
      process.stdout.write(`Web GUI: ${engine.url}\n`)
      openBrowser(engine.url)
      if (!engine.started) return 0
      return new Promise<number>(() => undefined)
    }
    case 'tui': {
      const engine = await ensureEngine(flag(args, '--server') ?? `http://${DEFAULT_HOST}:${port}`)
      const configFile = path.join(defaultDataDir(), 'tui.json')
      await new Tui(new HarnessClient(engine.url), configFile, engine.url).start()
      return new Promise<number>(() => undefined)
    }
    case 'user': {
      if (args[0] !== 'add' || !args[1]) {
        process.stderr.write('usage: harness user add <name> [--admin]\n')
        return 2
      }
      const password = await askHidden(`Password for ${args[1]} (8+ characters): `)
      const user = new Store().createUser({ username: args[1], password, isAdmin: args.includes('--admin') })
      process.stdout.write(`created ${user.username}${user.isAdmin ? ' (admin)' : ''}; workspaces: ${user.workspaceRoots.join(', ')}\n`)
      return 0
    }
    default:
      process.stderr.write(`unknown command: ${command}\n${HELP}`)
      return 2
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
