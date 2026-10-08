import fs from 'fs'
import os from 'os'
import path from 'path'
import { readAuth, writeAuth } from '../store'
import { helpText } from '../main'
import { codeforgeForgeBuildEnv, writeCodeForgeForgeConfig } from './launch'
import { PRODUCT_BIN, PRODUCT_NAME } from './suite'

it('CodeForge identity reads ~/.codeforge auth and brands the product', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-id-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  try {
    writeAuth({
      token: 'codeforge-jwt',
      email: 'ada@codeforge.dev',
      user_id: 'u1',
      api_base: 'https://www.codeforge.dev',
    })
    const auth = readAuth()
    expect(auth?.token).toBe('codeforge-jwt')
    expect(auth?.api_base).toBe('https://www.codeforge.dev')
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(true)
    expect(PRODUCT_NAME).toBe('CodeForge')
    expect(PRODUCT_BIN).toBe('codeforge')
    const env = codeforgeForgeBuildEnv()
    expect(env.FORGE_API_KEY).toBe('codeforge-jwt')
    expect(env.FORGE_FORGE_API_BASE_URL).toBe('https://www.codeforge.dev/api/runtime/v1')
    expect(env.FORGE_HOME).toBe(path.join(home, 'engine'))
    expect(env.CODEFORGE_HOME).toBeUndefined()
    expect(writeCodeForgeForgeConfig()).toBe(path.join(home, 'engine', 'config.toml'))
    expect(helpText()).not.toMatch(/forge\.com|auth\.forge\.dev|SpaceFORGE/)
    expect(helpText()).toContain('~/.codeforge')
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})
