import fs from 'fs'
import path from 'path'


export function forgeBuildRoot(): string {
  return path.resolve(__dirname, '..', '..', 'vendor', 'forge-build')
}

export const FORGE_BUILD_SURFACE = {
  agent: 'crates/codegen/forge-forge-agent',
  tools: 'crates/codegen/forge-forge-tools',
  pager: 'crates/codegen/codeforge-pager',
  hooks: 'crates/codegen/forge-forge-hooks',
  mcp: 'crates/codegen/forge-forge-mcp',
  plugins: 'crates/codegen/forge-forge-plugin-marketplace',
  subagents: 'crates/codegen/forge-forge-subagent-resolution',
  skills: 'crates/codegen/forge-forge-tools/src/implementations/skills',
} as const

export type ForgeBuildSurface = keyof typeof FORGE_BUILD_SURFACE

export function forgeBuildPath(surface: ForgeBuildSurface | 'license' | 'notice' | 'thirdParty'): string {
  const root = forgeBuildRoot()
  if (surface === 'license') return path.join(root, 'LICENSE')
  if (surface === 'notice') return path.join(root, 'NOTICE')
  if (surface === 'thirdParty') return path.join(root, 'THIRD-PARTY-NOTICES')
  return path.join(root, FORGE_BUILD_SURFACE[surface])
}

export function forgeBuildSuitePresent(): { surface: string; path: string; ok: boolean }[] {
  const keys: Array<ForgeBuildSurface | 'license' | 'notice'> = [
    'agent',
    'tools',
    'pager',
    'hooks',
    'mcp',
    'plugins',
    'subagents',
    'skills',
    'license',
    'notice',
  ]
  return keys.map((surface) => {
    const file = forgeBuildPath(surface)
    return { surface, path: file, ok: fs.existsSync(file) }
  })
}

export function assertForgeBuildSuite(): void {
  const missing = forgeBuildSuitePresent().filter((row) => !row.ok)
  if (missing.length) {
    throw new Error(`forge-build suite missing: ${missing.map((row) => row.surface).join(', ')}`)
  }
}

export const PRODUCT_NAME = 'CodeForge'
export const PRODUCT_BIN = 'codeforge'
export const COMPLETE_PATH = '/api/runtime/complete'
export const OPENAI_COMPAT_PATH = '/api/runtime/v1/chat/completions'
