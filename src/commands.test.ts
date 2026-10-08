import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  execCommand,
  formatCliReleaseStatus,
  formatQuota,
  listConversationsCommand,
  listLocalCommand,
  listModelsCommand,
  loginCommand,
  logoutCommand,
  openBrowserSafely,
  openCommand,
  openConversationCommand,
  resolveVerificationUrl,
  setModelCommand,
  statusCommand,
  webLoginCommand,
} from './commands'
import { CODEFORGE_CLIENT_VERSION } from './client'
import { readAuth, readSession, writeAuth, writeSession } from './store'

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-cmd-'))
}

describe('codeforge commands', () => {
  const previous = process.env.CODEFORGE_HOME

  afterEach(() => {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
  })

  it('logs in against /api/auth/login and can log out', async () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    const http = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'jwt-token',
        user: { id: 'u1', email: 'ada@example.com', plan_code: 'pro' },
      }),
      text: async () => '',
    })

    const email = await loginCommand(
      { email: 'ada@example.com', password: 'secret', apiBase: 'https://www.codeforge.dev' },
      http,
    )
    expect(email).toBe('ada@example.com')
    expect(http).toHaveBeenCalledWith(
      'https://www.codeforge.dev/api/auth/login',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(readAuth()?.token).toBe('jwt-token')
    expect(await statusCommand()).toContain('user ada@example.com (pro)')

    logoutCommand()
    expect(readAuth()).toBeNull()
    expect(await statusCommand()).toContain('user logged out')
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('completes a web device login by polling then persists via /auth/me', async () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    const http = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          device_code: 'dev-1',
          user_code: 'AB12-CD34',
          verification_uri: 'https://www.codeforge.dev/api/auth/cli/verify',
          verification_uri_complete: 'https://www.codeforge.dev/api/auth/cli/verify?user_code=AB12-CD34',
          interval: 0,
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 428,
        json: async () => ({ detail: 'authorization_pending' }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'jwt-web', user: { email: 'ada@example.com' } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'u1', email: 'ada@example.com', plan_code: 'pro' }),
        text: async () => '',
      })
    const opened: string[] = []
    const email = await webLoginCommand({
      apiBase: 'https://www.codeforge.dev',
      openBrowser: (url) => { opened.push(url) },
      sleep: async () => undefined,
    }, http)
    expect(email).toBe('ada@example.com')
    expect(opened[0]).toContain('user_code=AB12-CD34')
    expect(http.mock.calls[0][0]).toBe('https://www.codeforge.dev/api/auth/cli/device')
    expect(http.mock.calls[3][0]).toBe('https://www.codeforge.dev/api/auth/me')
    expect(readAuth()?.token).toBe('jwt-web')
    expect(await statusCommand()).toContain('user ada@example.com')
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('exchanges a pasted grant code and reuses stored identity', async () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    const http = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'jwt-grant', user: { email: 'ada@example.com' } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'u1', email: 'ada@example.com', plan_code: 'lab' }),
        text: async () => '',
      })
    await webLoginCommand({ grantCode: 'GRANT-9', apiBase: 'https://www.codeforge.dev', openBrowser: () => undefined }, http)
    expect(http.mock.calls[0][0]).toContain('/api/auth/cli/device/exchange')
    expect(readAuth()?.token).toBe('jwt-grant')
    expect(await statusCommand()).toContain('user ada@example.com')
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('keeps polling for the server-advertised lifetime instead of a two-minute cap', async () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    let polls = 0
    const http = jest.fn(async (url: string) => {
      if (url.endsWith('/api/auth/cli/device')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: 'dev-ttl',
            user_code: 'AA11-BB22',
            verification_uri: 'https://www.codeforge.dev/api/auth/cli/verify',
            verification_uri_complete: 'https://www.codeforge.dev/api/auth/cli/verify?user_code=AA11-BB22',
            interval: 1,
            expires_in: 3,
          }),
          text: async (): Promise<string> => '',
        }
      }
      polls += 1
      return {
        ok: false,
        status: 428,
        json: async () => ({ detail: 'authorization_pending' }),
        text: async (): Promise<string> => '',
      }
    })
    await expect(webLoginCommand({
      apiBase: 'https://www.codeforge.dev',
      openBrowser: () => undefined,
      sleep: async () => undefined,
    }, http)).rejects.toThrow(/timed out/)
    expect(polls).toBe(3)
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('resolves a relative verify path against the selected apiBase', async () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    const opened: string[] = []
    const http = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          device_code: 'dev-rel',
          user_code: 'AA11-BB22',
          verification_uri: '/api/auth/cli/verify',
          verification_uri_complete: '/api/auth/cli/verify?user_code=AA11-BB22',
          interval: 0,
        }),
        text: async (): Promise<string> => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'jwt-web', user: { email: 'ada@example.com' } }),
        text: async (): Promise<string> => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'u1', email: 'ada@example.com' }),
        text: async (): Promise<string> => '',
      })
    await webLoginCommand({
      apiBase: 'http://127.0.0.1:8000',
      openBrowser: (url) => { opened.push(url) },
      sleep: async () => undefined,
    }, http)
    expect(opened[0]).toBe('http://127.0.0.1:8000/api/auth/cli/verify?user_code=AA11-BB22')
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('rewrites a stale production verify host back onto the selected apiBase', () => {
    expect(resolveVerificationUrl(
      'https://www.codeforge.dev/api/auth/cli/verify?user_code=AA11-BB22',
      'http://127.0.0.1:8000',
    )).toBe('http://127.0.0.1:8000/api/auth/cli/verify?user_code=AA11-BB22')
  })

  it('opens Windows https URLs with start and an empty title', () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    const fake = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args })
      return {
        on() { return this },
        unref() { return this },
      }
    }) as unknown as typeof import('child_process').spawn
    openBrowserSafely('https://www.codeforge.dev/api/auth/cli/verify?user_code=AA-11', fake, 'win32')
    expect(calls[0].cmd).toBe('cmd.exe')
    expect(calls[0].args[0]).toBe('/c')
    expect(calls[0].args[1]).toBe('start')
    expect(calls[0].args[2]).toBe('')
    expect(calls[0].args[3]).toMatch(/^https:\/\//)
    expect(calls.some((item) => item.cmd === 'explorer.exe')).toBe(false)
  })

  it('does not throw when the desktop opener is missing', () => {
    const fake = ((() => {
      const child = {
        on(event: string, handler: (error: Error) => void) {
          if (event === 'error') handler(Object.assign(new Error('not found'), { code: 'ENOENT' }))
          return child
        },
        unref() { return child },
      }
      return child
    }) as unknown) as typeof import('child_process').spawn
    expect(() => openBrowserSafely('https://www.codeforge.dev/api/auth/cli/verify', fake, 'linux')).not.toThrow()
  })

  it('explains a 404 device start instead of dumping Not Found', async () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    const http = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ detail: 'Not Found' }),
      text: async () => '',
    })
    await expect(webLoginCommand({
      apiBase: 'https://www.codeforge.dev',
      openBrowser: () => undefined,
    }, http)).rejects.toThrow(/not on this server yet/i)
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('cancels web login when the device poll is denied', async () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    const http = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          device_code: 'dev-x',
          user_code: 'ZZ-ZZ',
          verification_uri: 'https://www.codeforge.dev/api/auth/cli/verify',
          verification_uri_complete: 'https://www.codeforge.dev/api/auth/cli/verify?user_code=ZZ-ZZ',
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ detail: 'access_denied' }),
        text: async () => '',
      })
    await expect(webLoginCommand({
      apiBase: 'https://www.codeforge.dev',
      openBrowser: () => undefined,
      sleep: async () => undefined,
    }, http)).rejects.toThrow(/cancelled/)
    expect(readAuth()).toBeNull()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('logs in with a browser token and fetches /auth/me', async () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    const http = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'u9', email: 'ada@example.com', plan_code: 'lab' }),
      text: async () => '',
    })
    await loginCommand({ token: 'pasted-jwt', apiBase: 'https://www.codeforge.dev' }, http)
    expect(http).toHaveBeenCalledWith(
      'https://www.codeforge.dev/api/auth/me',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer pasted-jwt' }) }),
    )
    expect(readAuth()?.plan_code).toBe('lab')
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('formatCliReleaseStatus reports package version and pager stamp', () => {
    expect(formatCliReleaseStatus('0.3.3', '0.3.3')).toBe('cli 0.3.3\npager 0.3.3')
    expect(formatCliReleaseStatus('0.3.3', '')).toBe('cli 0.3.3\npager none\npager behind — run codeforge update')
    expect(formatCliReleaseStatus('0.3.8', '0.3.6')).toBe(
      'cli 0.3.8\npager 0.3.6\npager behind — run codeforge update',
    )
  })

  it('shows live quota after login', async () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    writeAuth({
      token: 'jwt-token',
      email: 'ada@example.com',
      user_id: 'u1',
      api_base: 'https://www.codeforge.dev',
      plan_code: 'pro',
    })
    const http = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        total: 12000,
        plan: { balance: 8000, plan_name: 'Pro', plan_code: 'pro' },
        wallet: { balance: 3000 },
        bonus: { balance: 1000 },
        allowance: { unlimited: false, limit: 8000, used: 200 },
      }),
      text: async () => '',
    })
    const text = await statusCommand(http)
    expect(text).toContain(`cli ${CODEFORGE_CLIENT_VERSION}`)
    expect(text).toMatch(/^pager /m)
    expect(text).toContain('quota 12000 pts')
    expect(text).toContain('wallet 3000')
    expect(http).toHaveBeenCalledWith(
      'https://www.codeforge.dev/api/points/balance',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer jwt-token' }) }),
    )
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('opens an existing local repo into the shared workspace registry', async () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-open-'))
    fs.writeFileSync(path.join(repo, 'README.md'), 'x\n')

    const line = openCommand('proj-9', repo)
    expect(line).toContain(repo)
    expect(await statusCommand()).toContain('workspace proj-9')

    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('lists local files only after login and a bound workspace', () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    expect(() => listLocalCommand()).toThrow(/not logged in/)
    writeAuth({ token: 't', email: 'a@b.c', user_id: 'u', api_base: 'https://www.codeforge.dev' })
    expect(() => listLocalCommand()).toThrow(/no local workspace/)

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-ls-'))
    fs.writeFileSync(path.join(repo, 'main.py'), 'print(1)\n')
    fs.mkdirSync(path.join(repo, 'src'))
    openCommand('proj-ls', repo)
    const listing = listLocalCommand()
    expect(listing).toContain('main.py')
    expect(listing).toContain('src/')

    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-ls-b-'))
    openCommand('proj-other', other)
    const listed = listLocalCommand()
    expect(listed).toContain('proj-ls')
    expect(listed).toContain(repo)
    expect(listed).toContain('proj-other')
    expect(listed).toContain(other)
    expect(listed).not.toMatch(/multiple workspaces/)
    expect(listLocalCommand('proj-ls')).toContain('main.py')

    fs.rmSync(other, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('executes a prompt via the local runtime and bills through /api/runtime/complete', async () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    writeAuth({ token: 'jwt-token', email: 'ada@example.com', user_id: 'u1', api_base: 'https://www.codeforge.dev' })
    const http = jest.fn(async (url: string) => {
      if (String(url).includes('/api/runtime/v1/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            default_model: 'codeforge-lite',
            data: [{ id: 'codeforge-lite', name: 'CodeForge-Lite', owned_by: 'codeforge' }],
          }),
          text: async () => '',
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => 'event: text\ndata: "ok from cloud"\n\n',
      }
    })

    const result = await execCommand('summarize this repo', { newConversation: true }, http)
    expect(result.text).toBe('ok from cloud')
    expect(result.conversationId).toBeTruthy()
    expect(http.mock.calls.map((row) => row[0])).toContain('https://www.codeforge.dev/api/runtime/v1/models')
    const completeCall = http.mock.calls.find((row) => String(row[0]).includes('/api/runtime/complete')) as
      | [string, { body?: string; headers?: Record<string, string> }?]
      | undefined
    expect(completeCall?.[0]).toBe('https://www.codeforge.dev/api/runtime/complete')
    expect(completeCall?.[1]?.headers?.['x-codeforge-conversation-id']).toBe(result.conversationId)
    const body = JSON.parse(String(completeCall?.[1]?.body || '{}'))
    expect(body.model).toBe('codeforge-lite')
    expect(body.model).not.toBe('codeforge-default')
    expect(body.messages).toEqual([{ role: 'user', content: 'summarize this repo' }])
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'read_file',
      'search_replace',
      'grep',
      'bash',
    ])
    expect(body.client).toBe('cli')
    expect(body.client_version).toBe(require('../package.json').version)
    expect(body.client_request_id).toBeTruthy()
    expect(body.task_category).toBeUndefined()
    expect(body.message).toBeUndefined()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('lists and switches models from /api/runtime/v1/models', async () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    writeAuth({ token: 'tok', email: 'ada@example.com', user_id: 'u1', api_base: 'https://www.codeforge.dev' })
    const http = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        default_model: 'codeforge-lite',
        data: [
          { id: 'codeforge-lite', name: 'CodeForge-Lite', owned_by: 'codeforge' },
          { id: 'codeforge-pro', name: 'CodeForge-Pro', owned_by: 'codeforge' },
        ],
      }),
    })
    const listed = await listModelsCommand(http)
    expect(listed).toContain('* codeforge-lite')
    expect(listed).toContain('codeforge-pro')
    expect(listed).not.toContain('acme')
    expect(listed).not.toContain('forge-4.6')
    writeSession({ ...readSession(), last_model: 'acme-opus-4.8' })
    const listedStale = await listModelsCommand(http)
    expect(listedStale).toContain('* codeforge-lite')
    expect(listedStale).not.toContain('acme-opus-4.8')
    expect(await setModelCommand('CodeForge-Pro', http)).toBe('model codeforge-pro')
    expect(readSession().last_model).toBe('codeforge-pro')
    await expect(setModelCommand('nope', http)).rejects.toThrow(/unknown model/)
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('lists cloud conversations and opens one locally', async () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    writeAuth({ token: 'jwt-token', email: 'ada@example.com', user_id: 'u1', api_base: 'https://www.codeforge.dev' })
    const http = jest.fn(async (url: string) => {
      if (String(url).includes('/api/chat/conversations?source=cli')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'conv-9', title: 'prior', source: 'cli' }],
          text: async () => '',
        }
      }
      if (String(url).includes('/api/chat/conversations/conv-9')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'conv-9',
            title: 'prior',
            messages: [
              { role: 'user', content: 'hello' },
              { role: 'assistant', content: 'world' },
            ],
          }),
          text: async () => '',
        }
      }
      return { ok: false, status: 500, json: async () => ({}), text: async () => '' }
    })
    expect(await listConversationsCommand(http)).toContain('conv-9  prior [cli]')
    expect(http.mock.calls[0][0]).toBe('https://www.codeforge.dev/api/chat/conversations?source=cli&limit=30')
    const thread = await openConversationCommand('conv-9', http)
    expect(thread).toContain('opened conv-9')
    expect(thread).toContain('user: hello')
    expect(thread).toContain('assistant: world')
    expect(readSession().last_conversation_id).toBe('conv-9')
    fs.rmSync(home, { recursive: true, force: true })
  })
})

describe('formatQuota', () => {
  it('formats a normal and unlimited balance', () => {
    expect(formatQuota({
      total: 10,
      plan: { balance: 4, plan_name: 'Lab' },
      wallet: { balance: 6 },
      bonus: { balance: 0 },
      allowance: { unlimited: false, limit: 4, used: 1 },
    })).toContain('quota 10 pts')
    expect(formatQuota({ allowance: { unlimited: true } })).toBe('quota unlimited')
  })
})
