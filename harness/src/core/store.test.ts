import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { tempStore } from '../test-helpers'
import { workspaceAllowed } from './store'

test('users can log in and tokens resolve to the user', () => {
  const store = tempStore()
  assert.equal(store.needsSetup(), true)
  const admin = store.createUser({ username: 'admin', password: 'correct horse', isAdmin: true })
  assert.equal(store.needsSetup(), false)
  assert.equal(store.login('admin', 'wrong password'), null)
  const session = store.login('ADMIN', 'correct horse')
  assert.ok(session)
  assert.equal(store.userForToken(session.token)?.id, admin.id)
  assert.equal('passwordHash' in session.user, false)
  store.logout(session.token)
  assert.equal(store.userForToken(session.token), undefined)
})

test('user validation rejects short passwords, duplicates and removing the last admin', () => {
  const store = tempStore()
  assert.throws(() => store.createUser({ username: 'a b', password: 'longenough' }), /username/)
  assert.throws(() => store.createUser({ username: 'bob', password: 'short' }), /8 characters/)
  const admin = store.createUser({ username: 'admin', password: 'longenough', isAdmin: true })
  assert.throws(() => store.createUser({ username: 'Admin', password: 'longenough' }), /taken/)
  assert.throws(() => store.updateUser(admin.id, { isAdmin: false }), /last admin/)
  assert.throws(() => store.deleteUser(admin.id), /last admin/)
})

test('profile API keys are encrypted at rest and never exposed', () => {
  const store = tempStore()
  const user = store.createUser({ username: 'alice', password: 'longenough' })
  const profile = store.createProfile(user.id, { name: 'work', provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-secret-1234' })
  assert.equal(profile.hasKey, true)
  assert.equal(profile.apiKeyHint, '…1234')
  assert.equal(JSON.stringify(profile).includes('secret'), false)
  const raw = fs.readFileSync(path.join(store.dataDir, 'profiles.json'), 'utf8')
  assert.equal(raw.includes('sk-ant-secret'), false)
  assert.equal(store.profileApiKey(user.id, profile.id), 'sk-ant-secret-1234')
  // Another user cannot see or use it.
  const bob = store.createUser({ username: 'bob', password: 'longenough' })
  assert.deepEqual(store.listProfiles(bob.id), [])
  assert.throws(() => store.profileApiKey(bob.id, profile.id), /not found/)
})

test('an Anthropic profile needs a key; OpenAI-compatible local servers do not', () => {
  const store = tempStore()
  const user = store.createUser({ username: 'alice', password: 'longenough' })
  assert.throws(() => store.createProfile(user.id, { name: 'x', provider: 'anthropic', model: 'claude-opus-5-5' }), /API key/)
  const local = store.createProfile(user.id, { name: 'ollama', provider: 'openai', model: 'qwen3', baseUrl: 'http://localhost:11434/v1' })
  assert.equal(local.hasKey, false)
})

test('non-admin sessions are confined to the user workspace roots', () => {
  const store = tempStore()
  const user = store.createUser({ username: 'alice', password: 'longenough' })
  const root = user.workspaceRoots[0]
  assert.equal(workspaceAllowed(user, path.join(root, 'project')), true)
  assert.equal(workspaceAllowed(user, path.join(root, '..', 'elsewhere')), false)
  const profile = store.createProfile(user.id, { name: 'o', provider: 'openai', model: 'm', baseUrl: 'http://localhost:1/v1' })
  assert.throws(() => store.createSession(user, { profileId: profile.id, workspace: '/' }), /workspace must be inside/)
  const session = store.createSession(user, { profileId: profile.id })
  assert.equal(session.workspace, root)
  assert.equal(store.listSessions(user.id).length, 1)
})
