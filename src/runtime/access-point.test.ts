import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeAuth, readAuth } from '../store'
import { runTui } from '../tui'
import {
  accessPointBfullEnabled,
  findForgeBuildBinary,
  codeforgeForgeBuildEnv,
} from './launch'

type MockRuntime = {
  baseUrl: string
  close: () => Promise<void>
  hits: { method: string; url: string }[]
}


function startMockRuntime(): Promise<MockRuntime> {
  const hits: { method: string; url: string }[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/'
    hits.push({ method: req.method || 'GET', url })
    if (req.method === 'GET' && url === '/api/runtime/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, complete: true, models: true }))
      return
    }
    if (req.method === 'GET' && url === '/api/runtime/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'codeforge-model', object: 'model', owned_by: 'codeforge' }],
          default_model: 'codeforge-model',
        }),
      )
      return
    }
    if (req.method === 'POST' && url === '/api/runtime/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
      )
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ detail: 'not found' }))
  })

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('mock runtime failed to bind'))
        return
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        hits,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()))
          }),
      })
    })
    server.on('error', reject)
  })
}

function makeHome(apiBase: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-ap-'))
  process.env.CODEFORGE_HOME = home
  writeAuth({
    token: 'codeforge-jwt-acceptance',
    email: 'ada@codeforge.dev',
    user_id: 'u1',
    api_base: apiBase,
  })
  return home
}

function assertHostContract(env: NodeJS.ProcessEnv, home: string, apiBase: string): void {
  const runtime = `${apiBase.replace(/\/+$/, '')}/api/runtime/v1`
  expect(env.CODEFORGE_ACCESS_POINT).toBe('1')
  expect(env.CODEFORGE_HOME).toBeUndefined()
  expect(env.FORGE_DEFAULT_MODEL).toBeUndefined()
  expect(env.FORGE_HOME).toBe(path.join(home, 'engine'))
  expect(env.FORGE_CLI_CHAT_PROXY_BASE_URL).toBeTruthy()
  expect(env.FORGE_CLI_CHAT_PROXY_BASE_URL).toBe(runtime)
  expect(env.FORGE_CLI_CHAT_PROXY_BASE_URL).not.toMatch(/forge\.com/i)
  expect(env.FORGE_FORGE_API_BASE_URL).not.toMatch(/forge\.com|api\.forge\.dev/i)
  expect(env.FORGE_MODELS_LIST_URL).toBe(`${runtime}/models`)
  if (accessPointBfullEnabled()) {
    expect(env.FORGE_API_KEY).toBeUndefined()
    expect(env.CODEFORGE_TOKEN).toBe('codeforge-jwt-acceptance')
  } else {
    expect(env.FORGE_API_KEY).toBe('codeforge-jwt-acceptance')
    expect(env.CODEFORGE_TOKEN).toBeUndefined()
  }
  const forgeAuth = JSON.parse(String(env.FORGE_AUTH || '{}')) as { key?: string; auth_mode?: string }
  expect(forgeAuth.key).toBe('codeforge-jwt-acceptance')
  expect(forgeAuth.auth_mode).toBe('api_key')
  expect(String(env.FORGE_AUTH || '')).not.toMatch(/auth\.forge\.dev|accounts\.forge\.dev|forge\.com/)
}

it('host contract twice: CodeForge account, no CODEFORGE_HOME on child, no forge-4.6 default', async () => {
  const previous = {
    home: process.env.CODEFORGE_HOME,
    forge: process.env.FORGE_API_KEY,
    token: process.env.CODEFORGE_TOKEN,
    def: process.env.FORGE_DEFAULT_MODEL,
    bfull: process.env.CODEFORGE_ACCESS_POINT_BFULL,
  }
  delete process.env.CODEFORGE_ACCESS_POINT_BFULL
  process.env.FORGE_API_KEY = 'sk-forge-from-shell'
  process.env.FORGE_DEFAULT_MODEL = 'forge-4.6'

  const mock = await startMockRuntime()
  const home = makeHome(mock.baseUrl)
  try {
    const first = codeforgeForgeBuildEnv()
    assertHostContract(first, home, mock.baseUrl)

    const second = codeforgeForgeBuildEnv()
    assertHostContract(second, home, mock.baseUrl)

    const auth = readAuth()
    expect(auth?.token).toBe('codeforge-jwt-acceptance')
    expect(auth?.email).toBe('ada@codeforge.dev')
    expect(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).token).toBe(
      'codeforge-jwt-acceptance',
    )
  } finally {
    await mock.close()
    if (previous.home === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous.home
    if (previous.forge === undefined) delete process.env.FORGE_API_KEY
    else process.env.FORGE_API_KEY = previous.forge
    if (previous.token === undefined) delete process.env.CODEFORGE_TOKEN
    else process.env.CODEFORGE_TOKEN = previous.token
    if (previous.def === undefined) delete process.env.FORGE_DEFAULT_MODEL
    else process.env.FORGE_DEFAULT_MODEL = previous.def
    if (previous.bfull === undefined) delete process.env.CODEFORGE_ACCESS_POINT_BFULL
    else process.env.CODEFORGE_ACCESS_POINT_BFULL = previous.bfull
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('probe 404 does not spawn pager', async () => {
  const written: string[] = []
  const io = {
    write(text: string) {
      written.push(text)
    },
    question: async () => '/quit',
    questionPassword: async () => '/quit',
  }
  const spawnForgePager = jest.fn().mockResolvedValue(0)
  const code = await runTui(io, {
    auth: () => ({
      token: 'jwt',
      email: 'ada@codeforge.dev',
      user_id: 'u1',
      api_base: 'https://www.codeforge.dev',
    }),
    http: jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    spawnForgePager,
  })
  expect(spawnForgePager).not.toHaveBeenCalled()
  expect(written.join('')).toMatch(/will not fall back to Forge/i)
  expect(code).toBe(1)
})

it('direct pager without CODEFORGE_ACCESS_POINT exits 2; with flag --help works', () => {
  const repoBin = path.resolve(__dirname, '..', '..', 'bin', 'codeforge-pager')
  const binary = fs.existsSync(repoBin) ? repoBin : findForgeBuildBinary()
  if (!binary) {
    
    return
  }

  const deniedEnv = Object.fromEntries(
    Object.entries({ ...process.env }).filter(([k]) => k !== 'CODEFORGE_ACCESS_POINT'),
  )
  const denied = spawnSync(binary, ['--help'], {
    encoding: 'utf8',
    env: deniedEnv,
    timeout: 15_000,
  })
  expect(denied.status).toBe(2)
  expect(denied.stderr).toMatch(/run `codeforge`/)

  const allowed = spawnSync(binary, ['--help'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEFORGE_ACCESS_POINT: '1',
      FORGE_FORGE_API_BASE_URL: 'https://www.codeforge.dev/api/runtime/v1',
      FORGE_MODELS_LIST_URL: 'https://www.codeforge.dev/api/runtime/v1/models',
      FORGE_CLI_CHAT_PROXY_BASE_URL: 'https://www.codeforge.dev/api/runtime/v1',
      CODEFORGE_TOKEN: 'codeforge-jwt-acceptance',
      FORGE_API_KEY: 'codeforge-jwt-acceptance',
    },
    timeout: 15_000,
  })
  expect(allowed.status).toBe(0)
  expect(`${allowed.stdout}${allowed.stderr}`).toMatch(/CodeForge/)
})
