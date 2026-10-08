import fs from 'fs'
import os from 'os'
import path from 'path'

import { NATIVE_PAGER_FALLBACK_NOTICE, runTui, TUI_REQUIRES_TTY_NOTICE } from './tui'

function scriptedIo(answers: string[]) {
  const written: string[] = []
  const next = async () => {
    if (!answers.length) throw new Error('unexpected question')
    return answers.shift() as string
  }
  return {
    written,
    io: {
      write(text: string) {
        written.push(text)
      },
      question: next,
      questionPassword: next,
    },
  }
}

const account = { token: 'jwt', email: 'ada@codeforge.dev', user_id: 'u1', api_base: 'https://www.codeforge.dev' }

const healthyHttp = () =>
  jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, complete: true, models: true }),
  })

describe('codeforge tui', () => {
  it('signs in at startup when logged out, then spawns the native pager', async () => {
    const { io, written } = scriptedIo([])
    const webLogin = jest.fn(async (input: { onStart?: (info: { verification_uri: string; verification_uri_complete: string; user_code: string }) => void } = {}) => {
      input.onStart?.({
        verification_uri: 'https://www.codeforge.dev/api/auth/cli/verify',
        verification_uri_complete: 'https://www.codeforge.dev/api/auth/cli/verify?user_code=AA-11',
        user_code: 'AA-11',
      })
      return 'ada@codeforge.dev'
    })
    const auth = jest.fn().mockReturnValueOnce(null).mockReturnValue(account)
    const spawnForgePager = jest.fn().mockResolvedValue(0)
    const code = await runTui(io, { auth, webLogin, spawnForgePager, http: healthyHttp() })
    expect(code).toBe(0)
    expect(webLogin).toHaveBeenCalledTimes(1)
    expect(spawnForgePager).toHaveBeenCalledWith([])
    expect(written.join('')).toMatch(/Open https:\/\/www\.codeforge\.dev\/api\/auth\/cli\/verify/)
    expect(written.join('')).toMatch(/logged in as ada@codeforge\.dev/)
  })

  it('fails hard when the runtime health probe fails and never spawns the pager', async () => {
    const { io, written } = scriptedIo([])
    const spawnForgePager = jest.fn()
    const code = await runTui(io, {
      auth: () => account,
      spawnForgePager,
      http: jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    })
    expect(code).toBe(1)
    expect(spawnForgePager).not.toHaveBeenCalled()
    expect(written.join('')).toMatch(/CodeForge runtime is not available/)
    expect(written.join('')).not.toMatch(/fallback shell — not the full CodeForge TUI/)
  })

  it('refuses the interactive TUI without a terminal and points at codeforge exec', async () => {
    const { io, written } = scriptedIo([])
    const probe = jest.fn()
    const webLogin = jest.fn()
    const code = await runTui(io, {
      auth: () => account,
      webLogin,
      probe,
      http: healthyHttp(),
    })
    expect(code).toBe(1)
    expect(webLogin).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    expect(written.join('')).toContain(TUI_REQUIRES_TTY_NOTICE.trim())
    expect(written.join('')).toContain('codeforge exec "<prompt>"')
  })

  it('fails hard when the pager cannot be spawned at the last moment', async () => {
    const { io, written } = scriptedIo([])
    const spawnForgePager = jest.fn().mockResolvedValue(null)
    const code = await runTui(io, {
      auth: () => account,
      spawnForgePager,
      http: healthyHttp(),
    })
    expect(code).toBe(1)
    expect(spawnForgePager).toHaveBeenCalledTimes(1)
    expect(written.join('')).toContain(NATIVE_PAGER_FALLBACK_NOTICE.trim())
  })

  it('returns the native pager exit code', async () => {
    const { io } = scriptedIo([])
    const spawnForgePager = jest.fn().mockResolvedValue(42)
    const code = await runTui(io, {
      auth: () => account,
      spawnForgePager,
      http: healthyHttp(),
    })
    expect(code).toBe(42)
    expect(spawnForgePager).toHaveBeenCalledWith([])
  })

  it('does not open another browser login when a session already exists', async () => {
    const { io } = scriptedIo([])
    const webLogin = jest.fn()
    const spawnForgePager = jest.fn()
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(0)
    const code = await runTui(io, {
      auth: () => account,
      webLogin,
      spawnForgePager,
      http: healthyHttp(),
    })
    expect(code).toBe(0)
    expect(spawnForgePager).toHaveBeenCalledTimes(2)
    expect(spawnForgePager).toHaveBeenCalledWith([])
    expect(webLogin).not.toHaveBeenCalled()
  })

  it('passes --resume to the forge pager so exit hints work as codeforge --resume', async () => {
    const { io } = scriptedIo([])
    const spawnForgePager = jest.fn().mockResolvedValue(0)
    const code = await runTui(io, {
      auth: () => account,
      spawnForgePager,
      http: healthyHttp(),
      pagerArgs: ['--resume', '01a07c14-4b74-7460-8885-09183ee5d261'],
    })
    expect(code).toBe(0)
    expect(spawnForgePager).toHaveBeenCalledWith(['--resume', '01a07c14-4b74-7460-8885-09183ee5d261'])
  })

  it('does not mint a second device login after the startup browser login', async () => {
    const { io } = scriptedIo([])
    let session: { token: string; email: string; user_id: string; api_base: string } | null = null
    const webLogin = jest.fn(async () => {
      session = account
      return 'ada@codeforge.dev'
    })
    const spawnForgePager = jest.fn()
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(0)
    const code = await runTui(io, {
      auth: () => session,
      webLogin,
      spawnForgePager,
      http: healthyHttp(),
    })
    expect(code).toBe(0)
    expect(webLogin).toHaveBeenCalledTimes(1)
    expect(spawnForgePager).toHaveBeenCalledTimes(2)
  })

  it('stays on forge pager after exit 10 when a session is already saved', async () => {
    const { io, written } = scriptedIo([])
    const spawnForgePager = jest.fn()
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(0)
    const code = await runTui(io, {
      auth: () => account,
      webLogin: jest.fn(),
      spawnForgePager,
      http: healthyHttp(),
    })
    expect(code).toBe(0)
    expect(spawnForgePager).toHaveBeenCalledTimes(2)
    expect(written.join('')).not.toMatch(/session already saved/)
  })

  it('exits when the native pager cannot load instead of opening the fallback shell', async () => {
    const { io, written } = scriptedIo([])
    const previousBin = process.env.CODEFORGE_FORGE_BIN
    const previousTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-pager-missing-'))
    const dest = path.join(fake, 'codeforge-pager')
    fs.writeFileSync(dest, 'elf')
    process.env.CODEFORGE_FORGE_BIN = dest
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    try {
      const code = await runTui(io, {
        auth: () => account,
        pagerRunnable: () => false,
        http: healthyHttp(),
      })
      expect(code).toBe(1)
      expect(written.join('')).toContain(NATIVE_PAGER_FALLBACK_NOTICE.trim())
      expect(written.join('')).not.toMatch(/fallback shell — not the full CodeForge TUI/)
    } finally {
      if (previousBin === undefined) delete process.env.CODEFORGE_FORGE_BIN
      else process.env.CODEFORGE_FORGE_BIN = previousBin
      if (previousTty) Object.defineProperty(process.stdout, 'isTTY', previousTty)
      else delete (process.stdout as { isTTY?: boolean }).isTTY
      fs.rmSync(fake, { recursive: true, force: true })
    }
  })

  it('tells the user to reinstall when a native pager binary cannot exec', async () => {
    const { io, written } = scriptedIo([])
    const previousBin = process.env.CODEFORGE_FORGE_BIN
    const previousTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-pager-bin-'))
    const dest = path.join(fake, 'codeforge-pager')
    fs.writeFileSync(dest, 'elf')
    process.env.CODEFORGE_FORGE_BIN = dest
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    try {
      const code = await runTui(io, {
        auth: () => account,
        pagerRunnable: () => false,
        http: healthyHttp(),
      })
      expect(code).toBe(1)
      expect(written.join('')).toContain(NATIVE_PAGER_FALLBACK_NOTICE.trim())
      expect(written.join('')).toMatch(/codeforge update/)
    } finally {
      if (previousBin === undefined) delete process.env.CODEFORGE_FORGE_BIN
      else process.env.CODEFORGE_FORGE_BIN = previousBin
      if (previousTty) Object.defineProperty(process.stdout, 'isTTY', previousTty)
      else delete (process.stdout as { isTTY?: boolean }).isTTY
      fs.rmSync(fake, { recursive: true, force: true })
    }
  })

  it('stays a failed launch when the forge pager keeps exiting 10', async () => {
    const { io, written } = scriptedIo([])
    const spawnForgePager = jest.fn().mockResolvedValue(10)
    const code = await runTui(io, {
      auth: () => account,
      webLogin: jest.fn(),
      spawnForgePager,
      http: healthyHttp(),
    })
    expect(code).toBe(10)
    expect(spawnForgePager).toHaveBeenCalledTimes(2)
    expect(written.join('')).toMatch(/still requesting login/)
  })
})
