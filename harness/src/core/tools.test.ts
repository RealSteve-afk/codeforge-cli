import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../test-helpers'
import { findTool, resolveInWorkspace, toolInputSchema, TOOLS } from './tools'

const ctx = (workspace: string) => ({ workspace, signal: new AbortController().signal })

test('paths outside the workspace are refused, including through symlinks', () => {
  const ws = tempDir()
  const outside = tempDir()
  assert.throws(() => resolveInWorkspace(ws, '../x'), /outside the workspace/)
  assert.throws(() => resolveInWorkspace(ws, '/etc/passwd'), /outside the workspace/)
  fs.symlinkSync(outside, path.join(ws, 'link'))
  assert.throws(() => resolveInWorkspace(ws, 'link/secret.txt'), /outside the workspace/)
  assert.equal(resolveInWorkspace(ws, 'a/b.txt'), path.join(fs.realpathSync(ws), 'a', 'b.txt'))
})

test('write, read, edit and search files', async () => {
  const ws = tempDir()
  await findTool('write_file')!.run({ path: 'src/a.txt', content: 'one\ntwo\nthree' }, ctx(ws))
  const read = await findTool('read_file')!.run({ path: 'src/a.txt' }, ctx(ws))
  assert.match(read, /2\ttwo/)
  await findTool('edit_file')!.run({ path: 'src/a.txt', old_string: 'two', new_string: '2' }, ctx(ws))
  assert.equal(fs.readFileSync(path.join(ws, 'src/a.txt'), 'utf8'), 'one\n2\nthree')
  await assert.rejects(findTool('edit_file')!.run({ path: 'src/a.txt', old_string: 'missing', new_string: 'x' }, ctx(ws)), /not found/)
  const hits = await findTool('search')!.run({ pattern: 'thr' }, ctx(ws))
  assert.match(hits, /src[\\/]a\.txt:3: three/)
  assert.equal(await findTool('list_dir')!.run({ path: '.' }, ctx(ws)), 'src/')
})

test('run_command reports exit code and output, and honours timeouts', { skip: process.platform === 'win32' }, async () => {
  const ws = tempDir()
  const ok = await findTool('run_command')!.run({ command: 'echo hello && exit 3' }, ctx(ws))
  assert.match(ok, /^exit code 3\nhello/)
  const slow = await findTool('run_command')!.run({ command: 'sleep 5', timeout_seconds: 1 }, ctx(ws))
  assert.match(slow, /^timed out/)
})

test('every tool exposes an object JSON schema', () => {
  for (const tool of TOOLS) {
    const schema = toolInputSchema(tool)
    assert.equal(schema.type, 'object', tool.name)
    assert.equal('$schema' in schema, false)
  }
})
