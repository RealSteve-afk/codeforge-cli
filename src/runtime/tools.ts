import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { ToolCall, ToolDefinition, ToolName, ToolResult } from './types'

const MAX_READ_BYTES = 256 * 1024
const MAX_RESULT = 40_000

export const LOCAL_TOOL_NAMES: ToolName[] = ['read_file', 'search_replace', 'grep', 'bash']

export function localToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the local workspace. Path may be relative or absolute.',
        parameters: {
          type: 'object',
          properties: {
            target_file: { type: 'string' },
            path: { type: 'string' },
            offset: { type: 'integer' },
            limit: { type: 'integer' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_replace',
        description: 'Edit a file. Empty old_string creates or overwrites. replace_all replaces every match.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search file contents in the workspace (ripgrep if present).',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string' },
            glob: { type: 'string' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a shell command against the workspace cwd.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            cmd: { type: 'string' },
          },
          required: ['command'],
        },
      },
    },
  ]
}

export function resolveWorkspaceRoot(cwd?: string): string {
  const root = path.resolve(cwd || process.cwd())
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`workspace is not a directory: ${root}`)
  }
  return root
}

export function resolveInWorkspace(root: string, requested: string): string {
  const trimmed = (requested || '').trim() || '.'
  const absolute = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed)
  const rel = path.relative(root, absolute)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${requested}`)
  }
  return absolute
}

function clip(text: string): string {
  if (text.length <= MAX_RESULT) return text
  return `${text.slice(0, MAX_RESULT)}\n…truncated`
}

function str(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function readFileTool(root: string, input: Record<string, unknown>): string {
  const target = str(input, 'target_file', 'path', 'file_path')
  if (!target) throw new Error('read_file requires target_file or path')
  const file = resolveInWorkspace(root, target)
  const raw = fs.readFileSync(file)
  const start = Math.max(0, Number(input.offset) || 0)
  const limit = Number(input.limit)
  const text = raw.subarray(0, MAX_READ_BYTES).toString('utf8')
  const lines = text.split('\n')
  const slice = Number.isFinite(limit) && limit > 0 ? lines.slice(start, start + limit) : lines.slice(start)
  return slice.join('\n')
}

function searchReplaceTool(root: string, input: Record<string, unknown>): string {
  const filePath = str(input, 'file_path', 'path', 'target_file')
  if (!filePath) throw new Error('search_replace requires file_path')
  const oldString = typeof input.old_string === 'string' ? input.old_string : ''
  const newString = typeof input.new_string === 'string' ? input.new_string : String(input.contents ?? input.content ?? '')
  const file = resolveInWorkspace(root, filePath)
  if (!oldString) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, newString, 'utf8')
    return `The file ${filePath} has been created.`
  }
  if (!fs.existsSync(file)) throw new Error(`file not found: ${filePath}`)
  const before = fs.readFileSync(file, 'utf8')
  if (!before.includes(oldString)) throw new Error(`old_string not found in ${filePath}`)
  const replaceAll = Boolean(input.replace_all)
  const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString)
  fs.writeFileSync(file, after, 'utf8')
  return `The file ${filePath} has been updated.`
}

function walkFiles(dir: string, glob: string | undefined, acc: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, glob, acc)
    else if (!glob || matchGlob(entry.name, glob)) acc.push(full)
  }
}

function matchGlob(name: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`).test(name)
}

function grepTool(root: string, input: Record<string, unknown>): string {
  const pattern = str(input, 'pattern')
  if (!pattern) throw new Error('grep requires pattern')
  const searchRoot = resolveInWorkspace(root, str(input, 'path') || '.')
  const glob = str(input, 'glob') || undefined
  const rg = spawnSync('rg', ['--line-number', '--no-heading', '--color', 'never', pattern, searchRoot], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: MAX_RESULT,
  })
  if (rg.error || rg.status === 127) {
    const files: string[] = []
    if (fs.existsSync(searchRoot) && fs.statSync(searchRoot).isFile()) files.push(searchRoot)
    else walkFiles(searchRoot, glob, files)
    const re = new RegExp(pattern)
    const hits: string[] = []
    for (const file of files) {
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      lines.forEach((line, index) => {
        if (re.test(line)) hits.push(`${file}:${index + 1}:${line}`)
      })
    }
    return hits.length ? hits.join('\n') : 'no matches'
  }
  if (rg.status === 1) return 'no matches'
  if (rg.status !== 0) throw new Error(rg.stderr || `rg failed (${rg.status})`)
  return (rg.stdout || '').trim() || 'no matches'
}

function bashTool(root: string, input: Record<string, unknown>): string {
  const command = str(input, 'command', 'cmd')
  if (!command) throw new Error('bash requires command')
  const result = spawnSync(command, {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    timeout: 30_000,
    maxBuffer: MAX_RESULT,
    env: { ...process.env, CODEFORGE_WORKSPACE: root },
  })
  const out = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (result.error) throw new Error(result.error.message)
  if (result.status !== 0) {
    return clip(out || `exit ${result.status}`)
  }
  return clip(out || '(ok)')
}

export function dispatchLocalTool(root: string, call: ToolCall): ToolResult {
  try {
    const name = call.name
    let content = ''
    if (name === 'read_file') content = readFileTool(root, call.arguments)
    else if (name === 'search_replace') content = searchReplaceTool(root, call.arguments)
    else if (name === 'grep') content = grepTool(root, call.arguments)
    else if (name === 'bash' || name === 'run_terminal_cmd') content = bashTool(root, call.arguments)
    else throw new Error(`unknown tool: ${name}`)
    return { id: call.id, name, content: clip(content), ok: true }
  } catch (error) {
    return {
      id: call.id,
      name: call.name,
      content: error instanceof Error ? error.message : String(error),
      ok: false,
    }
  }
}
