import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { fetchPage, normalizeUrl, searchWeb, type SearchConfig, WebError } from './web'

export type PlanStatus = 'pending' | 'in_progress' | 'done'
export interface PlanItem {
  text: string
  status: PlanStatus
}

export interface ToolContext {
  workspace: string
  signal: AbortSignal
  // Interactive hooks supplied by the agent.
  askUser?: (question: string, options: string[], allowText: boolean) => Promise<string>
  updatePlan?: (items: PlanItem[]) => void
  // Client-side web access (used by providers without built-in web tools).
  search?: SearchConfig
  urlAllowed?: (url: string) => boolean
}

export interface ToolDef {
  name: string
  description: string
  schema: z.ZodType
  // Tools that change files or run programs need approval in "ask" mode.
  mutates: boolean
  run(input: any, ctx: ToolContext): Promise<string>
}

export class ToolError extends Error {}

const MAX_OUTPUT = 30_000
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', '__pycache__'])

function truncate(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} characters]`
}

// Resolve a model-supplied path and refuse anything outside the workspace,
// including escapes through symlinks.
export function resolveInWorkspace(workspace: string, requested: string): string {
  const root = fs.realpathSync(workspace)
  const target = path.resolve(root, requested || '.')
  let probe = target
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  const real = path.join(fs.realpathSync(probe), path.relative(probe, target))
  const rel = path.relative(root, real)
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ToolError(`path "${requested}" is outside the workspace`)
  }
  return real
}

const readFile: ToolDef = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the workspace. Returns numbered lines. Use offset/limit (1-based line numbers) for large files.',
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root'),
    offset: z.number().int().min(1).optional().describe('First line to return (1-based)'),
    limit: z.number().int().min(1).max(5000).optional().describe('Maximum number of lines to return (default 2000)'),
  }),
  mutates: false,
  async run(input: { path: string; offset?: number; limit?: number }, ctx) {
    const file = resolveInWorkspace(ctx.workspace, input.path)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new ToolError(`no such file: ${input.path}`)
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const start = (input.offset ?? 1) - 1
    const slice = lines.slice(start, start + (input.limit ?? 2000))
    const body = slice.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join('\n')
    const more = start + slice.length < lines.length ? `\n[${lines.length - start - slice.length} more lines]` : ''
    return truncate(body + more)
  },
}

const listDir: ToolDef = {
  name: 'list_dir',
  description: 'List the entries of a directory in the workspace. Directories end with "/".',
  schema: z.object({ path: z.string().describe('Directory path, relative to the workspace root ("." for the root)') }),
  mutates: false,
  async run(input: { path: string }, ctx) {
    const dir = resolveInWorkspace(ctx.workspace, input.path)
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ToolError(`no such directory: ${input.path}`)
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
    return entries.length ? truncate(entries.join('\n')) : '(empty directory)'
  },
}

const search: ToolDef = {
  name: 'search',
  description:
    'Search file contents in the workspace with a JavaScript regular expression. Skips .git, node_modules and build output. Returns path:line: text.',
  schema: z.object({
    pattern: z.string().describe('Regular expression to search for'),
    path: z.string().optional().describe('Directory to search, relative to the workspace root (default ".")'),
    ignore_case: z.boolean().optional(),
  }),
  mutates: false,
  async run(input: { pattern: string; path?: string; ignore_case?: boolean }, ctx) {
    let regex: RegExp
    try {
      regex = new RegExp(input.pattern, input.ignore_case ? 'i' : '')
    } catch (error) {
      throw new ToolError(`invalid regular expression: ${(error as Error).message}`)
    }
    const root = fs.realpathSync(ctx.workspace)
    const start = resolveInWorkspace(ctx.workspace, input.path ?? '.')
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (hits.length >= 200 || ctx.signal.aborted) return
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full)
          continue
        }
        if (!entry.isFile() || fs.statSync(full).size > 1_000_000) continue
        const lines = fs.readFileSync(full, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (hits.length < 200 && regex.test(line)) hits.push(`${path.relative(root, full)}:${i + 1}: ${line.slice(0, 300)}`)
        })
      }
    }
    if (fs.statSync(start).isDirectory()) walk(start)
    return hits.length ? truncate(hits.join('\n')) : 'no matches'
  },
}

const writeFile: ToolDef = {
  name: 'write_file',
  description: 'Create or overwrite a text file in the workspace with the full contents given. Creates parent directories.',
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root'),
    content: z.string().describe('The complete new file contents'),
  }),
  mutates: true,
  async run(input: { path: string; content: string }, ctx) {
    const file = resolveInWorkspace(ctx.workspace, input.path)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, input.content, 'utf8')
    return `wrote ${input.content.length} characters to ${input.path}`
  },
}

const editFile: ToolDef = {
  name: 'edit_file',
  description:
    'Replace one exact occurrence of old_string with new_string in a workspace file. old_string must match exactly once, including whitespace.',
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root'),
    old_string: z.string().min(1).describe('Exact text to replace; must occur exactly once'),
    new_string: z.string().describe('Replacement text'),
  }),
  mutates: true,
  async run(input: { path: string; old_string: string; new_string: string }, ctx) {
    const file = resolveInWorkspace(ctx.workspace, input.path)
    if (!fs.existsSync(file)) throw new ToolError(`no such file: ${input.path}`)
    const text = fs.readFileSync(file, 'utf8')
    const count = text.split(input.old_string).length - 1
    if (count === 0) throw new ToolError('old_string was not found')
    if (count > 1) throw new ToolError(`old_string occurs ${count} times; include more context so it is unique`)
    fs.writeFileSync(file, text.replace(input.old_string, () => input.new_string), 'utf8')
    return `edited ${input.path}`
  },
}

const runCommand: ToolDef = {
  name: 'run_command',
  description:
    'Run a shell command in the workspace directory and return its exit code and combined output. Use for builds, tests, git and other CLI tools.',
  schema: z.object({
    command: z.string().min(1).describe('The shell command to run'),
    timeout_seconds: z.number().int().min(1).max(600).optional().describe('Timeout in seconds (default 120)'),
  }),
  mutates: true,
  run(input: { command: string; timeout_seconds?: number }, ctx) {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32'
      const child = spawn(isWin ? 'cmd.exe' : 'bash', isWin ? ['/d', '/s', '/c', input.command] : ['-c', input.command], {
        cwd: ctx.workspace,
        env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat' },
      })
      let output = ''
      const collect = (chunk: Buffer) => {
        if (output.length < MAX_OUTPUT * 2) output += chunk.toString('utf8')
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      let reason = ''
      const stop = (why: string) => {
        reason = why
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 2000).unref()
      }
      const timer = setTimeout(() => stop('timed out'), (input.timeout_seconds ?? 120) * 1000)
      const onAbort = () => stop('cancelled')
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      const finish = (code: number | null, error?: Error) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        const head = error ? `failed to start: ${error.message}` : reason ? `${reason} (exit ${code ?? 'killed'})` : `exit code ${code}`
        resolve(truncate(`${head}\n${output}`.trimEnd()))
      }
      child.on('error', (error) => finish(null, error))
      child.on('close', (code) => finish(code))
    })
  },
}

const askUser: ToolDef = {
  name: 'ask_user',
  description:
    'Ask the user a question and wait for the answer. Use it when you need a decision only the user can make (a choice between approaches, missing requirements). Offer 2-6 short options when the answer is a choice.',
  schema: z.object({
    question: z.string().min(1).describe('The question, in one or two sentences'),
    options: z.array(z.string().min(1)).max(6).optional().describe('Suggested answers the user can click'),
    allow_free_text: z.boolean().optional().describe('Whether the user may type their own answer (default true)'),
  }),
  mutates: false,
  async run(input: { question: string; options?: string[]; allow_free_text?: boolean }, ctx) {
    if (!ctx.askUser) throw new ToolError('asking the user is not available here')
    const answer = await ctx.askUser(input.question, input.options ?? [], input.allow_free_text ?? true)
    return answer ? `The user answered: ${answer}` : 'The user did not answer.'
  },
}

const updatePlan: ToolDef = {
  name: 'update_plan',
  description:
    'Show the user a checklist of the steps for the current task and their status. Call it at the start of a task with three or more steps, and again whenever a step starts or finishes. Send the full list every time.',
  schema: z.object({
    items: z
      .array(z.object({ text: z.string().min(1), status: z.enum(['pending', 'in_progress', 'done']) }))
      .min(1)
      .max(20),
  }),
  mutates: false,
  async run(input: { items: PlanItem[] }, ctx) {
    ctx.updatePlan?.(input.items)
    const done = input.items.filter((i) => i.status === 'done').length
    return `plan updated (${done}/${input.items.length} done)`
  },
}

const webSearch: ToolDef = {
  name: 'web_search',
  description: 'Search the web. Returns titles, URLs and snippets. Use it for current information, documentation and facts you are unsure of.',
  schema: z.object({ query: z.string().min(1).describe('Search query') }),
  mutates: false,
  async run(input: { query: string }, ctx) {
    if (!ctx.search) throw new ToolError('web search is not configured')
    try {
      const results = await searchWeb(ctx.search, input.query)
      if (!results.length) return 'no results'
      return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n')
    } catch (error) {
      throw new ToolError((error as Error).message)
    }
  },
}

const webFetch: ToolDef = {
  name: 'web_fetch',
  description:
    'Fetch a web page and return its readable text. Only URLs that the user gave or that appeared in earlier search results or tool output can be fetched.',
  schema: z.object({ url: z.string().url().describe('The http(s) URL to fetch') }),
  mutates: false,
  async run(input: { url: string }, ctx) {
    const url = normalizeUrl(input.url)
    if (!url || (ctx.urlAllowed && !ctx.urlAllowed(url))) {
      throw new ToolError('that URL has not appeared in this conversation; search for it first or ask the user for it')
    }
    try {
      const page = await fetchPage(input.url, { signal: ctx.signal })
      return `${page.title ? `# ${page.title}\n` : ''}${page.url}\n\n${page.text}`
    } catch (error) {
      throw new ToolError(error instanceof WebError ? error.message : `fetch failed: ${(error as Error).message}`)
    }
  },
}

export const TOOLS: ToolDef[] = [readFile, listDir, search, writeFile, editFile, runCommand]
export const INTERACTIVE_TOOLS: ToolDef[] = [askUser, updatePlan]
export const CLIENT_WEB_TOOLS: ToolDef[] = [webSearch, webFetch]
const ALL_TOOLS = [...TOOLS, ...INTERACTIVE_TOOLS, ...CLIENT_WEB_TOOLS]

// Tools offered to the model. Client-side web tools are only for providers
// without built-in web search; web_search needs a configured backend.
export function toolsFor(options: { clientWeb: boolean; searchConfigured: boolean }): ToolDef[] {
  const web = options.clientWeb ? CLIENT_WEB_TOOLS.filter((t) => t.name !== 'web_search' || options.searchConfigured) : []
  return [...TOOLS, ...INTERACTIVE_TOOLS, ...web]
}

export function findTool(name: string, tools: ToolDef[] = ALL_TOOLS): ToolDef | undefined {
  return tools.find((tool) => tool.name === name)
}

// JSON Schema for a tool's input, without the "$schema" key the providers do not need.
export function toolInputSchema(tool: ToolDef): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.schema) as Record<string, unknown>
  return schema
}
