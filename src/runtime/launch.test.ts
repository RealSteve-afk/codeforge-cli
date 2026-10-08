import fs from 'fs'
import os from 'os'
import path from 'path'
import { runCli } from '../main'
import { readSession, writeAuth, writeSession } from '../store'
import { execCommand } from '../commands'
import { forgeBuildPath } from './suite'
import {
  assertRuntimeAvailable,
  forgeBuildBinaryCandidates,
  migrateForgeScratchToEngine,
  pagerBinaryName,
  prependToolPath,
  purgeChangelogCache,
  purgeForgeEngineAuth,
  RuntimeUnavailable,
  firstReadableDir,
  pagerBinaryRunnable,
  pagerProbeCwd,
  pagerSpawnCwd,
  pagerStampAllowsSpawn,
  codeforgeForgeBuildEnv,
  writeCodeForgeForgeConfig,
} from './launch'

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-launch-'))
  process.env.CODEFORGE_HOME = home
  writeAuth({
    token: 'jwt',
    email: 'ada@codeforge.dev',
    user_id: 'u1',
    api_base: 'https://www.codeforge.dev',
  })
  return home
}

it('codeforgeForgeBuildEnv prepends to a "Path"-spelled PATH instead of replacing it', () => {
  
  
  
  
  
  const previousHome = process.env.CODEFORGE_HOME
  const previousPath = process.env.PATH
  const previousAltPath = process.env.Path
  const inherited = ['C:\\Windows\\System32', 'C:\\Program Files\\Git\\bin'].join(path.delimiter)
  const home = makeHome()
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    delete process.env.PATH
    process.env.Path = inherited
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    fs.mkdirSync(path.join(home, 'node'), { recursive: true })
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true })

    const env = codeforgeForgeBuildEnv()

    const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')
    expect(pathKeys).toHaveLength(1)
    const value = String(env[pathKeys[0]])
    for (const dir of inherited.split(path.delimiter)) expect(value).toContain(dir)
    expect(value).toContain(path.join(home, 'node'))
    expect(value).toContain(path.join(home, 'bin'))
  } finally {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor)
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    delete process.env.Path
    if (previousPath !== undefined) process.env.PATH = previousPath
    if (previousAltPath !== undefined) process.env.Path = previousAltPath
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('codeforgeForgeBuildEnv removes the shell Forge key whatever its casing', () => {
  const previousHome = process.env.CODEFORGE_HOME
  const previousLower = process.env.forge_api_key
  const home = makeHome()
  try {
    process.env.forge_api_key = 'sk-forge-from-shell'
    const env = codeforgeForgeBuildEnv()
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'FORGE_API_KEY')).toHaveLength(1)
    expect(String(env.FORGE_API_KEY || '')).not.toBe('sk-forge-from-shell')
  } finally {
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    if (previousLower === undefined) delete process.env.forge_api_key
    else process.env.forge_api_key = previousLower
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('codeforgeForgeBuildEnv stamps a stable CODEFORGE_CONVERSATION_ID', () => {
  const previousHome = process.env.CODEFORGE_HOME
  const previousConv = process.env.CODEFORGE_CONVERSATION_ID
  const home = makeHome()
  try {
    delete process.env.CODEFORGE_CONVERSATION_ID
    const a = codeforgeForgeBuildEnv()
    const b = codeforgeForgeBuildEnv()
    expect(a.CODEFORGE_CONVERSATION_ID).toMatch(/^[0-9a-f-]{36}$/i)
    expect(a.CODEFORGE_CONVERSATION_ID).toBe(b.CODEFORGE_CONVERSATION_ID)
    expect(readSession().last_conversation_id).toBe(a.CODEFORGE_CONVERSATION_ID)
  } finally {
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    if (previousConv === undefined) delete process.env.CODEFORGE_CONVERSATION_ID
    else process.env.CODEFORGE_CONVERSATION_ID = previousConv
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('codeforgeForgeBuildEnv keeps a valid UUID last_conversation_id', () => {
  const previousHome = process.env.CODEFORGE_HOME
  const previousConv = process.env.CODEFORGE_CONVERSATION_ID
  const home = makeHome()
  const kept = '11111111-1111-1111-1111-111111111111'
  try {
    delete process.env.CODEFORGE_CONVERSATION_ID
    writeSession({ last_conversation_id: kept, last_model: 'codeforge-lite' })
    const env = codeforgeForgeBuildEnv()
    expect(env.CODEFORGE_CONVERSATION_ID).toBe(kept)
    expect(readSession().last_conversation_id).toBe(kept)
    expect(readSession().last_model).toBe('codeforge-lite')
  } finally {
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    if (previousConv === undefined) delete process.env.CODEFORGE_CONVERSATION_ID
    else process.env.CODEFORGE_CONVERSATION_ID = previousConv
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('codeforgeForgeBuildEnv opts into the harness updater only with a new-enough pager', () => {
  const previousHome = process.env.CODEFORGE_HOME
  const home = makeHome()
  const pagerDir = path.join(home, 'bin')
  const stamp = (version: string) => {
    fs.mkdirSync(pagerDir, { recursive: true })
    fs.writeFileSync(path.join(pagerDir, 'codeforge-pager.version'), `${version}\n`)
  }
  try {
    expect(codeforgeForgeBuildEnv().CODEFORGE_AUTO_UPDATE).toBeUndefined()
    stamp('0.3.37')
    expect(codeforgeForgeBuildEnv().CODEFORGE_AUTO_UPDATE).toBeUndefined()
    stamp('0.3.38')
    expect(codeforgeForgeBuildEnv().CODEFORGE_AUTO_UPDATE).toBe('1')
  } finally {
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('codeforgeForgeBuildEnv replaces a non-UUID last_conversation_id', () => {
  const previousHome = process.env.CODEFORGE_HOME
  const previousConv = process.env.CODEFORGE_CONVERSATION_ID
  const home = makeHome()
  try {
    delete process.env.CODEFORGE_CONVERSATION_ID
    writeSession({ last_conversation_id: 'conv-99' })
    const env = codeforgeForgeBuildEnv()
    expect(env.CODEFORGE_CONVERSATION_ID).toMatch(/^[0-9a-f-]{36}$/i)
    expect(env.CODEFORGE_CONVERSATION_ID).not.toBe('conv-99')
    expect(readSession().last_conversation_id).toBe(env.CODEFORGE_CONVERSATION_ID)
  } finally {
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    if (previousConv === undefined) delete process.env.CODEFORGE_CONVERSATION_ID
    else process.env.CODEFORGE_CONVERSATION_ID = previousConv
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('codeforgeForgeBuildEnv unsets FORGE_DEFAULT_MODEL', () => {
  const previousHome = process.env.CODEFORGE_HOME
  const previousDefault = process.env.FORGE_DEFAULT_MODEL
  const home = makeHome()
  try {
    process.env.FORGE_DEFAULT_MODEL = 'forge-4.6'
    const env = codeforgeForgeBuildEnv()
    expect(env.FORGE_DEFAULT_MODEL).toBeUndefined()
  } finally {
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    if (previousDefault === undefined) delete process.env.FORGE_DEFAULT_MODEL
    else process.env.FORGE_DEFAULT_MODEL = previousDefault
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('codeforgeForgeBuildEnv points forge-build at CodeForge via FORGE_FORGE_API_BASE_URL', () => {
  const previousHome = process.env.CODEFORGE_HOME
  const home = makeHome()
  try {
    const env = codeforgeForgeBuildEnv()
    expect(env.FORGE_FORGE_API_BASE_URL).toBe('https://www.codeforge.dev/api/runtime/v1')
    expect(env.FORGE_FORGE_API_BASE_URL).toContain('/api/runtime/v1')
    expect(env.FORGE_FORGE_API_BASE_URL).not.toContain('forge.com')
    expect(env.FORGE_FORGE_API_BASE_URL).not.toContain('api.forge.dev')
    expect(env.FORGE_MODELS_LIST_URL).toBe('https://www.codeforge.dev/api/runtime/v1/models')
    expect(env.FORGE_MODELS_BASE_URL).toBe('https://www.codeforge.dev/api/runtime/v1')
    expect(env.FORGE_CLI_CHAT_PROXY_BASE_URL).not.toContain('forge.com')
    expect(env.FORGE_TELEMETRY_ENABLED).toBe('0')
    expect(env.FORGE_DISABLE_API_KEY_AUTH).toBeUndefined()
    const configPath = writeCodeForgeForgeConfig()
    expect(configPath).toBe(path.join(home, 'engine', 'config.toml'))
    expect(fs.readFileSync(configPath, 'utf8')).toContain('forge_api_base_url = "https://www.codeforge.dev/api/runtime/v1"')
    expect(fs.readFileSync(configPath, 'utf8')).toContain('system_prompt_label = "CodeForge"')
    expect(env.FORGE_SYSTEM_PROMPT_LABEL).toBe('CodeForge')
    const bootPath = path.join(path.dirname(forgeBuildPath('pager')), 'codeforge-pager-bin', 'src', 'codeforge_boot.rs')
    if (fs.existsSync(bootPath)) {
      const boot = fs.readFileSync(bootPath, 'utf8')
      expect(boot).toMatch(/FORGE_FORGE_API_BASE_URL/)
      expect(boot).toMatch(/api\/runtime\/v1/)
    }
  } finally {
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('purges Forge OAuth leftovers from engine auth.json', () => {
  const previousHome = process.env.CODEFORGE_HOME
  const home = makeHome()
  const engine = path.join(home, 'engine')
  fs.mkdirSync(engine, { recursive: true })
  const file = path.join(engine, 'auth.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      'https://auth.forge.dev::deadbeef': {
        auth_mode: 'oidc',
        key: 'forge-session',
        oidc_issuer: 'https://auth.forge.dev',
        refresh_token: 'refresh',
      },
    }),
  )
  try {
    purgeForgeEngineAuth(engine)
    expect(fs.readFileSync(file, 'utf8').trim()).toBe('{}')
    fs.writeFileSync(
      file,
      JSON.stringify({
        'https://auth.forge.dev::again': { auth_mode: 'oidc', key: 'forge-session' },
      }),
    )
    codeforgeForgeBuildEnv()
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/auth\.forge\.dev/)
  } finally {
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('B-lite contract: no CODEFORGE_HOME on child, engine home, overwritten FORGE_API_KEY', () => {
  const previous = {
    home: process.env.CODEFORGE_HOME,
    apiKey: process.env.FORGE_API_KEY,
    engineHome: process.env.FORGE_HOME,
    code: process.env.FORGE_CODE_FORGE_API_KEY,
    def: process.env.FORGE_DEFAULT_MODEL,
  }
  process.env.FORGE_API_KEY = 'sk-forge-from-shell'
  process.env.FORGE_CODE_FORGE_API_KEY = 'legacy'
  process.env.FORGE_DEFAULT_MODEL = 'forge-4.6'
  const home = makeHome()
  try {
    const env = codeforgeForgeBuildEnv()
    expect(env.CODEFORGE_HOME).toBeUndefined()
    expect(env.CODEFORGE_ACCESS_POINT).toBe('1')
    expect(env.FORGE_HOME).toBe(path.join(home, 'engine'))
    expect(env.FORGE_AUTH_PATH).toBe(path.join(home, 'engine', 'auth.json'))
    expect(env.CODEFORGE_AUTH_PATH).toBe(path.join(home, 'auth.json'))
    expect(env.FORGE_API_KEY).toBe('jwt')
    expect(env.FORGE_API_KEY).not.toBe('sk-forge-from-shell')
    expect(env.FORGE_CODE_FORGE_API_KEY).toBeUndefined()
    expect(env.FORGE_DEFAULT_MODEL).toBeUndefined()
    expect(env.FORGE_CLI_CHAT_PROXY_BASE_URL).toBe('https://www.codeforge.dev/api/runtime/v1')
    expect(env.FORGE_CLI_CHAT_PROXY_BASE_URL).not.toBe('')
    expect(env.FORGE_MODELS_LIST_URL).toBe('https://www.codeforge.dev/api/runtime/v1/models')
    expect(env.FORGE_CHANGELOG_OFFLINE).toBe('1')
    expect(env.CODEFORGE_TOKEN).toBeUndefined()
    const forgeAuth = JSON.parse(String(env.FORGE_AUTH || '{}')) as { key?: string; auth_mode?: string }
    expect(forgeAuth.key).toBe('jwt')
    expect(forgeAuth.auth_mode).toBe('api_key')
    expect(String(env.FORGE_AUTH)).not.toMatch(/auth\.forge\.dev|accounts\.forge\.dev|forge\.com/)
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).token).toBe('jwt')
  } finally {
    if (previous.home === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous.home
    if (previous.apiKey === undefined) delete process.env.FORGE_API_KEY
    else process.env.FORGE_API_KEY = previous.apiKey
    if (previous.engineHome === undefined) delete process.env.FORGE_HOME
    else process.env.FORGE_HOME = previous.engineHome
    if (previous.code === undefined) delete process.env.FORGE_CODE_FORGE_API_KEY
    else process.env.FORGE_CODE_FORGE_API_KEY = previous.code
    if (previous.def === undefined) delete process.env.FORGE_DEFAULT_MODEL
    else process.env.FORGE_DEFAULT_MODEL = previous.def
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('puts the private Node bin ahead of PATH so the TUI can run npm', () => {
  const previousHome = process.env.CODEFORGE_HOME
  const previousPath = process.env.PATH
  const home = makeHome()
  const nodeBin = path.join(home, 'node', 'bin')
  fs.mkdirSync(nodeBin, { recursive: true })
  fs.writeFileSync(path.join(nodeBin, 'npm'), '#!/bin/sh\n')
  try {
    process.env.PATH = '/usr/bin:/bin'
    const env = codeforgeForgeBuildEnv()
    const parts = String(env.PATH || '').split(path.delimiter)
    expect(parts[0]).toBe(nodeBin)
    expect(prependToolPath('/usr/bin', home).startsWith(`${nodeBin}${path.delimiter}`)).toBe(true)
  } finally {
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('names the Windows pager binary with an .exe suffix', () => {
  expect(pagerBinaryName('win32')).toBe('codeforge-pager.exe')
  expect(pagerBinaryName('darwin')).toBe('codeforge-pager')
  expect(pagerBinaryName('linux')).toBe('codeforge-pager')
  const candidates = forgeBuildBinaryCandidates()
  const expected = pagerBinaryName()
  expect(candidates.some((item) => item.endsWith(path.join('bin', expected)))).toBe(true)
})

it('refuses spawn of an installed pager whose stamp is older than this package', () => {
  const previousHome = process.env.CODEFORGE_HOME
  const home = makeHome()
  const dest = path.join(home, 'bin', 'codeforge-pager')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, 'old')
  fs.writeFileSync(`${dest}.version`, '0.0.1\n')
  try {
    expect(pagerStampAllowsSpawn(dest)).toBe(false)
    expect(pagerStampAllowsSpawn(path.join(home, 'elsewhere', 'codeforge-pager'))).toBe(true)
    fs.writeFileSync(`${dest}.version`, '0.3.11\n')
    expect(pagerStampAllowsSpawn(dest)).toBe(true)
  } finally {
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('picks the first readable directory and skips an unreadable preferred cwd', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-cwd-ok-'))
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-cwd-block-'))
  fs.chmodSync(blocked, 0)
  try {
    expect(firstReadableDir([blocked, home])).toBe(home)
    expect(pagerSpawnCwd(blocked, home)).toBe(home)
    expect(pagerProbeCwd(home)).toBe(home)
  } finally {
    fs.chmodSync(blocked, 0o700)
    fs.rmSync(blocked, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('treats GLIBC loader errors as an unrunnable pager', () => {
  const previousHome = process.env.CODEFORGE_HOME
  const spawn = jest.fn().mockReturnValue({
    status: 127,
    stdout: '',
    stderr:
      "/root/.codeforge/bin/codeforge-pager: /usr/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found (required by /root/.codeforge/bin/codeforge-pager)\n",
    error: undefined,
  })
  const home = makeHome()
  const dest = path.join(home, 'bin', 'codeforge-pager')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, 'elf')
  try {
    expect(pagerBinaryRunnable(dest, spawn as never)).toBe(false)
    expect(spawn).toHaveBeenCalledWith(
      dest,
      ['--help'],
      expect.objectContaining({ encoding: 'utf8', cwd: pagerProbeCwd() }),
    )
  } finally {
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('treats a pager that starts as runnable', () => {
  const previousHome = process.env.CODEFORGE_HOME
  const spawn = jest.fn().mockReturnValue({ status: 0, stdout: 'usage', stderr: '', error: undefined })
  const home = makeHome()
  const dest = path.join(home, 'bin', 'codeforge-pager')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, 'elf')
  try {
    expect(pagerBinaryRunnable(dest, spawn as never)).toBe(true)
  } finally {
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('B-full unsets FORGE_API_KEY and sets CODEFORGE_TOKEN once pager stamp matches', () => {
  const previous = {
    home: process.env.CODEFORGE_HOME,
    forge: process.env.FORGE_API_KEY,
    token: process.env.CODEFORGE_TOKEN,
    bfull: process.env.CODEFORGE_ACCESS_POINT_BFULL,
  }
  process.env.CODEFORGE_ACCESS_POINT_BFULL = '1'
  process.env.FORGE_API_KEY = 'sk-forge-from-shell'
  const home = makeHome()
  try {
    const env = codeforgeForgeBuildEnv()
    expect(env.FORGE_API_KEY).toBeUndefined()
    expect(env.CODEFORGE_TOKEN).toBe('jwt')
    expect(env.FORGE_CODE_FORGE_API_KEY).toBeUndefined()
    expect(env.CODEFORGE_CONVERSATION_ID).toMatch(/^[0-9a-f-]{36}$/i)
    expect(env.CODEFORGE_ACCESS_POINT).toBe('1')
    expect(JSON.parse(String(env.FORGE_AUTH)).auth_mode).toBe('api_key')
    expect(JSON.parse(String(env.FORGE_AUTH)).key).toBe('jwt')
  } finally {
    if (previous.home === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous.home
    if (previous.forge === undefined) delete process.env.FORGE_API_KEY
    else process.env.FORGE_API_KEY = previous.forge
    if (previous.token === undefined) delete process.env.CODEFORGE_TOKEN
    else process.env.CODEFORGE_TOKEN = previous.token
    if (previous.bfull === undefined) delete process.env.CODEFORGE_ACCESS_POINT_BFULL
    else process.env.CODEFORGE_ACCESS_POINT_BFULL = previous.bfull
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('assertRuntimeAvailable throws RuntimeUnavailable on 404', async () => {
  const http = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
  await expect(assertRuntimeAvailable(http, 'https://www.codeforge.dev')).rejects.toBeInstanceOf(RuntimeUnavailable)
})

it('assertRuntimeAvailable resolves on {ok:true}', async () => {
  const http = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, complete: true, models: true }),
  })
  await expect(assertRuntimeAvailable(http, 'https://www.codeforge.dev')).resolves.toBeUndefined()
  expect(http).toHaveBeenCalledWith('https://www.codeforge.dev/api/runtime/health', expect.anything())
})

it('migrateForgeScratchToEngine moves sessions and leaves CodeForge auth.json', () => {
  const home = makeHome()
  fs.mkdirSync(path.join(home, 'sessions'))
  fs.writeFileSync(path.join(home, 'sessions', 'a.json'), '{}')
  fs.writeFileSync(path.join(home, 'CHANGELOG.md'), 'forge notes')
  try {
    migrateForgeScratchToEngine(home)
    purgeChangelogCache(home, path.join(home, 'engine'))
    expect(fs.existsSync(path.join(home, 'engine', 'sessions', 'a.json'))).toBe(true)
    expect(fs.existsSync(path.join(home, 'sessions'))).toBe(false)
    expect(fs.existsSync(path.join(home, 'CHANGELOG.md'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).token).toBe('jwt')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('migrateForgeScratchToEngine keeps colliding scratch instead of deleting it', () => {
  const home = makeHome()
  fs.mkdirSync(path.join(home, 'sessions'))
  fs.mkdirSync(path.join(home, 'engine', 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(home, 'sessions', 'keep-me.json'), '{"from":"old"}')
  fs.writeFileSync(path.join(home, 'engine', 'sessions', 'keep-me.json'), '{"from":"engine"}')
  fs.writeFileSync(path.join(home, 'sessions', 'only-old.json'), '{"from":"old-only"}')
  try {
    migrateForgeScratchToEngine(home)
    expect(JSON.parse(fs.readFileSync(path.join(home, 'engine', 'sessions', 'keep-me.json'), 'utf8'))).toEqual({
      from: 'engine',
    })
    expect(JSON.parse(fs.readFileSync(path.join(home, 'sessions', 'keep-me.json'), 'utf8'))).toEqual({
      from: 'old',
    })
    expect(fs.existsSync(path.join(home, 'engine', 'sessions', 'only-old.json'))).toBe(true)
    expect(fs.existsSync(path.join(home, 'sessions', 'only-old.json'))).toBe(false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('codeforge exec --stub completes a local-agent turn with a tool result twice', async () => {
  const previousHome = process.env.CODEFORGE_HOME
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-ws-'))
  fs.writeFileSync(path.join(cwd, 'hello.txt'), 'hello from workspace\n')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-home-'))
  process.env.CODEFORGE_HOME = home
  const previousCwd = process.cwd()
  process.chdir(cwd)
  const runs: string[] = []
  try {
    for (let i = 0; i < 2; i += 1) {
      const writes: string[] = []
      const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk))
        return true
      })
      try {
        const code = await runCli(['exec', '--stub', '--new', 'read hello.txt'])
        expect(code).toBe(0)
        const out = writes.join('')
        expect(out).toMatch(/local tool result/)
        expect(out).toMatch(/hello from workspace/)
        runs.push(out)
      } finally {
        stdout.mockRestore()
      }
    }
    expect(runs).toHaveLength(2)
    expect(runs[0]).toBe(runs[1])
  } finally {
    process.chdir(previousCwd)
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('execCommand stub path changes a workspace file through the shipped loop', async () => {
  const previousHome = process.env.CODEFORGE_HOME
  const home = makeHome()
  process.env.CODEFORGE_HOME = home
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-exec-'))
  fs.writeFileSync(path.join(cwd, 'hello.txt'), 'before\n')
  try {
    const result = await execCommand('edit', {
      stub: true,
      cwd,
      newConversation: true,
      modelClient: {
        async complete(request) {
          const hasTool = request.messages.some((row) => row.role === 'tool')
          if (!hasTool) {
            return {
              text: '',
              tool_calls: [
                {
                  id: 'e1',
                  name: 'search_replace',
                  arguments: { file_path: 'hello.txt', old_string: 'before', new_string: 'after' },
                },
              ],
            }
          }
          return { text: `edited:${request.messages.at(-1)?.content}`, tool_calls: [] }
        },
      },
    })
    expect(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8')).toBe('after\n')
    expect(result.text).toMatch(/edited:The file hello.txt has been updated/)
  } finally {
    if (previousHome === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})
