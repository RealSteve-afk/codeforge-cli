import { createRequire } from 'module'
import { randomUUID } from 'crypto'

const req = createRequire(__filename)
export const CODEFORGE_CLIENT_VERSION = String(req('../package.json').version || '0.1.0')

export type CodeForgeClientKind = 'cli' | 'tui'

export function clientStamp(kind: CodeForgeClientKind): {
  client: CodeForgeClientKind
  client_version: string
  client_request_id: string
} {
  return {
    client: kind,
    client_version: CODEFORGE_CLIENT_VERSION,
    client_request_id: randomUUID(),
  }
}
