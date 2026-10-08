import fs from 'fs'
import os from 'os'
import path from 'path'
import { collectLocalTurn, createScriptedModel, runLocalTurn } from './loop'
import { resolveWorkspaceRoot } from './tools'

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-loop-'))
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello codeforge\n')
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'note.md'), 'alpha beta\n')
  return root
}

it('drives the shipped local loop through read, edit, search, and shell', async () => {
  const cwd = makeWorkspace()
  const model = createScriptedModel([
    {
      tool_calls: [{ id: 'c1', name: 'read_file', arguments: { target_file: 'hello.txt' } }],
    },
    {
      tool_calls: [
        {
          id: 'c2',
          name: 'search_replace',
          arguments: { file_path: 'hello.txt', old_string: 'hello codeforge', new_string: 'hello local runtime' },
        },
      ],
    },
    {
      tool_calls: [{ id: 'c3', name: 'grep', arguments: { pattern: 'local runtime', path: '.' } }],
    },
    {
      tool_calls: [{ id: 'c4', name: 'bash', arguments: { command: 'printf changed && cat hello.txt' } }],
    },
    { text: 'done: workspace updated' },
  ])

  const seenRequests: string[][] = []
  const gen = runLocalTurn({
    prompt: 'update hello.txt locally',
    cwd,
    model: 'stub',
    client: {
      async complete(request) {
        seenRequests.push(request.messages.map((row) => `${row.role}:${row.content}`))
        return model.complete(request)
      },
    },
  })
  const events: string[] = []
  let step = await gen.next()
  while (!step.done) {
    if (step.value.text) events.push(`${step.value.type}:${step.value.text}`)
    step = await gen.next()
  }
  const result = step.value

  expect(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8')).toBe('hello local runtime\n')
  expect(result.toolResults.map((row) => row.name)).toEqual(['read_file', 'search_replace', 'grep', 'bash'])
  expect(result.toolResults.every((row) => row.ok)).toBe(true)
  expect(result.toolResults[0].content).toContain('hello codeforge')
  expect(result.toolResults[2].content).toMatch(/hello\.txt|local runtime/)
  expect(result.toolResults[3].content).toContain('hello local runtime')
  expect(result.text).toBe('done: workspace updated')
  expect(seenRequests.length).toBe(5)
  expect(seenRequests[1].some((row) => row.startsWith('tool:') && row.includes('hello codeforge'))).toBe(true)
  expect(seenRequests[2].some((row) => row.startsWith('tool:') && row.includes('has been updated'))).toBe(true)
  expect(seenRequests[3].some((row) => row.startsWith('tool:') && /local runtime/.test(row))).toBe(true)
  expect(seenRequests[4].some((row) => row.startsWith('tool:') && row.includes('hello local runtime'))).toBe(true)
  expect(result.requests[0].tools.map((tool) => tool.function.name)).toEqual([
    'read_file',
    'search_replace',
    'grep',
    'bash',
  ])
  expect(resolveWorkspaceRoot(cwd)).toBe(path.resolve(cwd))
  fs.rmSync(cwd, { recursive: true, force: true })
})

it('collectLocalTurn returns the same shipped-loop result', async () => {
  const cwd = makeWorkspace()
  const result = await collectLocalTurn({
    prompt: 'read it',
    cwd,
    model: 'stub',
    client: createScriptedModel([
      { tool_calls: [{ id: 'r1', name: 'read_file', arguments: { path: 'src/note.md' } }] },
      { text: 'note says alpha' },
    ]),
  })
  expect(result.toolResults[0].content).toContain('alpha beta')
  expect(result.text).toBe('note says alpha')
  fs.rmSync(cwd, { recursive: true, force: true })
})

it('retries a billed complete that returns neither text nor tool calls', async () => {
  const cwd = makeWorkspace()
  let rounds = 0
  const result = await collectLocalTurn({
    prompt: 'ping',
    cwd,
    model: 'stub',
    client: {
      async complete() {
        rounds += 1
        if (rounds === 1) return { text: '', tool_calls: [] }
        return { text: 'pong', tool_calls: [] }
      },
    },
  })
  expect(rounds).toBe(2)
  expect(result.text).toBe('pong')
  fs.rmSync(cwd, { recursive: true, force: true })
})
