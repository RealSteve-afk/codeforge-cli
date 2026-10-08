import { CODEFORGE_CLIENT_VERSION } from './client'
import { helpText, pagerResumeArgs, runCli } from './main'
import { readAuth } from './store'
import fs from 'fs'
import os from 'os'
import path from 'path'

it('maps codeforge --resume onto pager argv', () => {
  expect(pagerResumeArgs(['--resume', 'sess-abc'])).toEqual(['--resume', 'sess-abc'])
  expect(pagerResumeArgs(['tui', '--resume', 'sess-abc'])).toEqual(['--resume', 'sess-abc'])
  expect(pagerResumeArgs(['--resume'])).toEqual(['--resume'])
  expect(pagerResumeArgs([])).toEqual([])
  expect(pagerResumeArgs(['login', '--resume', 'nope'])).toEqual([])
})

it('names the web login path plus email/password/token in help', () => {
  const text = helpText()
  expect(text).toMatch(/codeforge --resume/)
  expect(text).toMatch(/npm install -g @realsteve-afk\/codeforge/)
  expect(text).toMatch(/browser/i)
  expect(text).toMatch(/--code/)
  expect(text).toMatch(/--email/)
  expect(text).toMatch(/--password/)
  expect(text).toMatch(/--token/)
  expect(text).toContain('Forge ahead.')
  expect(text).toContain('CodeForge')
  expect(text).not.toMatch(/Forge Build|SpaceFORGE/)
})

it('runCli --version names CodeForge, not Forge', async () => {
  const writes: string[] = []
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  try {
    const code = await runCli(['--version'])
    expect(code).toBe(0)
    const text = writes.join('')
    expect(text).toMatch(/^codeforge /)
    expect(text).toContain('Forge ahead.')
    expect(text).toContain('CodeForge')
    expect(text).not.toMatch(/Forge Build|SpaceFORGE/)
  } finally {
    stdout.mockRestore()
  }
})

it('runCli --help prints the web login path', async () => {
  const writes: string[] = []
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  try {
    const code = await runCli(['--help'])
    expect(code).toBe(0)
    expect(writes.join('')).toMatch(/browser/i)
    expect(writes.join('')).toMatch(/--token/)
  } finally {
    stdout.mockRestore()
  }
})

it('runCli login without flags starts the browser/device path', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-main-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  const writes: string[] = []
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  const http = jest.fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        device_code: 'dev-cli',
        user_code: 'AA11-BB22',
        verification_uri: 'https://www.codeforge.dev/api/auth/cli/verify',
        verification_uri_complete: 'https://www.codeforge.dev/api/auth/cli/verify?user_code=AA11-BB22',
        interval: 0,
      }),
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
      json: async () => ({ id: 'u', email: 'ada@example.com', plan_code: 'pro' }),
      text: async () => '',
    })
  try {
    const code = await runCli(['login', '--api', 'https://www.codeforge.dev'], { http })
    expect(code).toBe(0)
    expect(writes.join('')).toMatch(/Open https:\/\/www\.codeforge\.dev\/api\/auth\/cli\/verify\?user_code=AA11-BB22/)
    expect(writes.join('')).toMatch(/logged in as ada@example.com/)
    expect(readAuth()?.token).toBe('jwt-web')
    expect(readAuth()?.email).toBe('ada@example.com')
  } finally {
    stdout.mockRestore()
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('runCli login --code wins over CODEFORGE_TOKEN', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-main-'))
  const previousHome = process.env.CODEFORGE_HOME
  const previousToken = process.env.CODEFORGE_TOKEN
  process.env.CODEFORGE_HOME = home
  process.env.CODEFORGE_TOKEN = 'env-jwt'
  const writes: string[] = []
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
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
      json: async () => ({ id: 'u', email: 'ada@example.com', plan_code: 'pro' }),
      text: async () => '',
    })
  try {
    const code = await runCli(['login', '--code', 'GRANT-9', '--api', 'https://www.codeforge.dev'], { http })
    expect(code).toBe(0)
    expect(http.mock.calls[0][0]).toContain('/api/auth/cli/device/exchange')
    expect(writes.join('')).toMatch(/logged in as ada@example.com/)
    expect(readAuth()?.token).toBe('jwt-grant')
  } finally {
    stdout.mockRestore()
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    if (previousToken === undefined) delete process.env.CODEFORGE_TOKEN
    else process.env.CODEFORGE_TOKEN = previousToken
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('runCli login --token still prints logged in as', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-main-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  const writes: string[] = []
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  const http = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ id: 'u', email: 'ada@example.com', plan_code: 'pro' }),
    text: async () => '',
  })
  try {
    const code = await runCli(['login', '--token', 'pasted-jwt', '--api', 'https://www.codeforge.dev'], { http })
    expect(code).toBe(0)
    expect(writes.join('')).toMatch(/logged in as ada@example.com/)
    expect(readAuth()?.token).toBe('pasted-jwt')
  } finally {
    stdout.mockRestore()
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('runCli update invokes pager install with force when already on latest', async () => {
  const installPager = jest.fn().mockResolvedValue({ ok: true, dest: '/tmp/codeforge-pager' })
  const installPackage = jest.fn()
  const writes: string[] = []
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  try {
    const code = await runCli(['update'], {
      installPager,
      fetchLatest: async () => CODEFORGE_CLIENT_VERSION,
      installPackage,
    })
    expect(code).toBe(0)
    expect(installPackage).not.toHaveBeenCalled()
    expect(installPager).toHaveBeenCalledWith({ force: true })
    expect(writes.join('')).toMatch(/cli already/)
    expect(writes.join('')).toMatch(/pager/i)
  } finally {
    stdout.mockRestore()
  }
})

it('runCli update still npm-installs latest when the registry check fails', async () => {
  const installPager = jest.fn()
  const installPackage = jest.fn().mockResolvedValue(undefined)
  const writes: string[] = []
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  try {
    const code = await runCli(['update'], {
      installPager,
      fetchLatest: async () => {
        throw new Error('network down')
      },
      installPackage,
    })
    expect(code).toBe(0)
    expect(installPackage).toHaveBeenCalledWith('latest')
    expect(installPager).not.toHaveBeenCalled()
    expect(writes.join('')).toMatch(/cli /)
  } finally {
    stdout.mockRestore()
  }
})

it('runCli update upgrades the npm package when latest is newer', async () => {
  const installPager = jest.fn()
  const installPackage = jest.fn().mockResolvedValue(undefined)
  const writes: string[] = []
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  try {
    const code = await runCli(['update'], {
      installPager,
      fetchLatest: async () => '9.9.9',
      installPackage,
    })
    expect(code).toBe(0)
    expect(installPackage).toHaveBeenCalledWith('9.9.9')
    expect(installPager).not.toHaveBeenCalled()
    expect(writes.join('')).toMatch(/9\.9\.9/)
  } finally {
    stdout.mockRestore()
  }
})

it('help lists codeforge update', () => {
  expect(helpText()).toMatch(/codeforge update/)
  expect(helpText()).toMatch(/upgrade CLI/)
  expect(helpText()).toMatch(/\/api\/runtime\/v1\/models/)
  expect(helpText()).not.toMatch(/\/api\/chat\/models/)
  expect(helpText()).not.toMatch(/\bforge login|\bforge OAuth|auth\.forge\.dev/i)
})

it('runCli -p with empty model text exits 1 and writes stderr', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-main-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  const { writeAuth } = require('./store') as typeof import('./store')
  writeAuth({ token: 'jwt', email: 'ada@example.com', user_id: 'u1', api_base: 'https://www.codeforge.dev' })
  const stdout: string[] = []
  const stderr: string[] = []
  const out = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
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
      text: async () => 'event: text\ndata: ""\n\n',
    }
  })
  try {
    const code = await runCli(['-p', 'say hello', '--new'], { http })
    expect(code).toBe(1)
    expect(stdout.join('').trim()).toBe('')
    expect(stderr.join('')).toMatch(/no model text/)
  } finally {
    out.mockRestore()
    err.mockRestore()
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})
