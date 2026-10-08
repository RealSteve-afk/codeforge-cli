import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { getCodeForgeHome } from '../store'
import type { ModelMessage } from './types'

export interface LocalSession {
  id: string
  title: string
  cwd: string
  model?: string
  messages: ModelMessage[]
  updatedAt: string
}

function sessionsDir(): string {
  return path.join(getCodeForgeHome(), 'sessions')
}

function sessionFile(id: string): string {
  return path.join(sessionsDir(), `${id}.json`)
}

export function createLocalSession(title: string, cwd: string, model?: string, id?: string): LocalSession {
  const session: LocalSession = {
    id: id || randomUUID(),
    title: title.slice(0, 80) || 'session',
    cwd,
    model,
    messages: [],
    updatedAt: new Date().toISOString(),
  }
  saveLocalSession(session)
  return session
}

export function loadLocalSession(id: string): LocalSession | null {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')) as LocalSession
  } catch {
    return null
  }
}

export function saveLocalSession(session: LocalSession): void {
  fs.mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 })
  const file = sessionFile(session.id)
  fs.writeFileSync(file, JSON.stringify({ ...session, updatedAt: new Date().toISOString() }, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export function listLocalSessions(): LocalSession[] {
  const dir = sessionsDir()
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as LocalSession
      } catch {
        return null
      }
    })
    .filter((row): row is LocalSession => Boolean(row))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
