import fs from 'fs'
import os from 'os'
import path from 'path'
import { bindWorkspace, clearAuth, describeStatus, getCodeForgeHome, readAuth, readWorkspaces, writeAuth } from './store'

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-home-'))
}

describe('codeforge store', () => {
  const previous = process.env.CODEFORGE_HOME

  afterEach(() => {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
  })

  it('uses CODEFORGE_HOME instead of ~/.codeforge', () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    expect(getCodeForgeHome()).toBe(home)
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('round-trips auth and reports logged-out status', () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    expect(readAuth()).toBeNull()
    expect(describeStatus().logged_in).toBe(false)

    writeAuth({
      token: 'tok_1',
      email: 'ada@example.com',
      user_id: 'user-1',
      api_base: 'https://www.codeforge.dev',
    })
    expect(readAuth()?.email).toBe('ada@example.com')
    expect(describeStatus()).toMatchObject({
      logged_in: true,
      email: 'ada@example.com',
      api_base: 'https://www.codeforge.dev',
    })

    clearAuth()
    expect(readAuth()).toBeNull()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('treats CODEFORGE_HOME as a private directory: 0700 home, 0600 auth.json', () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    fs.chmodSync(home, 0o755)

    writeAuth({
      token: 'tok_secret',
      email: 'ada@example.com',
      user_id: 'user-1',
      api_base: 'https://www.codeforge.dev',
    })

    expect(fs.statSync(home).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(home, 'auth.json')).mode & 0o777).toBe(0o600)

    fs.chmodSync(path.join(home, 'auth.json'), 0o644)
    writeAuth({
      token: 'tok_secret_2',
      email: 'ada@example.com',
      user_id: 'user-1',
      api_base: 'https://www.codeforge.dev',
    })
    expect(fs.statSync(path.join(home, 'auth.json')).mode & 0o777).toBe(0o600)

    fs.rmSync(home, { recursive: true, force: true })
  })

  it('binds an existing directory into the shared workspace registry', () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-repo-'))
    fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n')

    const bound = bindWorkspace('proj-1', repo)
    expect(bound.path).toBe(fs.realpathSync.native(repo))
    expect(describeStatus().workspaces['proj-1']).toBe(bound.path)

    expect(() => bindWorkspace('proj-1', path.join(repo, 'missing'))).toThrow(/does not exist/)
    expect(fs.existsSync(path.join(repo, 'missing'))).toBe(false)

    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('prunes vanished workspace directories from the registry', () => {
    const home = makeHome()
    process.env.CODEFORGE_HOME = home
    const live = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-live-'))
    const gone = path.join(os.tmpdir(), `codeforge-gone-${Date.now()}`)
    bindWorkspace('keep', live)
    fs.writeFileSync(
      path.join(home, 'workspace-paths.json'),
      JSON.stringify({ keep: fs.realpathSync.native(live), gone }, null, 2) + '\n',
    )
    const map = readWorkspaces()
    expect(map.keep).toBe(fs.realpathSync.native(live))
    expect(map.gone).toBeUndefined()
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'workspace-paths.json'), 'utf8'))
    expect(saved.gone).toBeUndefined()
    expect(saved.keep).toBe(map.keep)
    fs.rmSync(live, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })
})
