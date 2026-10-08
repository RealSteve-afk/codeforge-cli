import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeAuth, readSession, writeSession } from '../store'
import { fetchModelCatalog, resolveCatalogModel, resolveRuntimeModel } from './models'

it('fetchModelCatalog uses /api/runtime/v1/models', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-model-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  writeAuth({ token: 'jwt', email: 'ada@codeforge.dev', user_id: 'u1', api_base: 'https://www.codeforge.dev' })
  const http = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      data: [{ id: 'codeforge-lite', name: 'CodeForge-Lite', owned_by: 'codeforge' }],
      default_model: 'codeforge-lite',
    }),
    text: async () => '',
  })
  try {
    const { models, defaultModel } = await fetchModelCatalog(http)
    expect(http.mock.calls[0][0]).toMatch(/\/api\/runtime\/v1\/models$/)
    expect(http.mock.calls[0][0]).not.toMatch(/\/api\/chat\/models/)
    expect(models[0].name).toBe('codeforge-lite')
    expect(defaultModel).toBe('codeforge-lite')
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('fetchModelCatalog does not fall back when runtime returns FastAPI 401 detail', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-model-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  writeAuth({ token: 'jwt', email: 'ada@codeforge.dev', user_id: 'u1', api_base: 'https://www.codeforge.dev' })
  const http = jest.fn(async (url: string) => {
    if (String(url).includes('/api/runtime/v1/models')) {
      return {
        ok: false,
        status: 401,
        json: async () => ({ detail: 'Not authenticated' }),
        text: async (): Promise<string> => '',
      }
    }
    throw new Error(`unexpected fallback request ${url}`)
  })
  try {
    await expect(fetchModelCatalog(http)).rejects.toThrow(/Not authenticated|models failed \(401\)/)
    expect(http.mock.calls.map((row) => row[0])).toEqual(['https://www.codeforge.dev/api/runtime/v1/models'])
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('does not fall back to /api/chat/models on runtime 404', async () => {
  const calls: string[] = []
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-model-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  writeAuth({ token: 'jwt', email: 'ada@codeforge.dev', user_id: 'u1', api_base: 'https://www.codeforge.dev' })
  const http = async (url: string) => {
    calls.push(url)
    if (url.includes('/api/runtime/v1/models')) {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    throw new Error(`unexpected ${url}`)
  }
  try {
    await expect(fetchModelCatalog(http as any)).rejects.toThrow(/models failed \(404\)/)
    expect(calls.some((u) => u.includes('/api/chat/models'))).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('does not fall back to /api/chat/models on runtime 502', async () => {
  const calls: string[] = []
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-model-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  writeAuth({ token: 'jwt', email: 'ada@codeforge.dev', user_id: 'u1', api_base: 'https://www.codeforge.dev' })
  const http = async (url: string) => {
    calls.push(url)
    if (url.includes('/api/runtime/v1/models')) {
      return { ok: false, status: 502, json: async () => ({ detail: 'bad gateway' }) }
    }
    throw new Error(`unexpected ${url}`)
  }
  try {
    await expect(fetchModelCatalog(http as any)).rejects.toThrow(/bad gateway|models failed \(502\)/)
    expect(calls.some((u) => u.includes('/api/chat/models'))).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('resolves codeforge-pro aliases and rejects kimi', async () => {
  const models = [
    { name: 'codeforge-lite', label: 'CodeForge-Lite' },
    { name: 'codeforge-pro', label: 'CodeForge-Pro' },
    { name: 'codeforge-ultra', label: 'CodeForge-Ultra' },
  ]
  expect(resolveCatalogModel('pro', models)?.name).toBe('codeforge-pro')
  expect(resolveCatalogModel('CodeForge-Ultra', models)?.name).toBe('codeforge-ultra')
  expect(resolveCatalogModel('kimi', models)).toBeUndefined()
  expect(resolveCatalogModel('kimi-k3', models)).toBeUndefined()
  expect(resolveCatalogModel('acme', models)).toBeUndefined()
  expect(resolveCatalogModel('forge-4.6', models)).toBeUndefined()
  expect(resolveCatalogModel('k3', models)).toBeUndefined()
})

it('drops stale last_model and uses default codeforge-lite', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-model-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  writeAuth({ token: 'jwt', email: 'ada@codeforge.dev', user_id: 'u1', api_base: 'https://www.codeforge.dev' })
  writeSession({ last_model: 'acme-opus-4.8' })
  const http = jest.fn(async (url: string) => {
    expect(url).toBe('https://www.codeforge.dev/api/runtime/v1/models')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        default_model: 'codeforge-lite',
        data: [
          { id: 'codeforge-lite', name: 'CodeForge-Lite', owned_by: 'codeforge' },
          { id: 'codeforge-pro', name: 'CodeForge-Pro', owned_by: 'codeforge' },
          { id: 'codeforge-ultra', name: 'CodeForge-Ultra', owned_by: 'codeforge' },
        ],
      }),
      text: async () => '',
    }
  })
  try {
    const name = await resolveRuntimeModel(http)
    expect(name).toBe('codeforge-lite')
    expect(readSession().last_model).toBe('codeforge-lite')
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('first-run exec without last_model uses GET /api/runtime/v1/models default', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeforge-model-'))
  const previous = process.env.CODEFORGE_HOME
  process.env.CODEFORGE_HOME = home
  writeAuth({ token: 'jwt', email: 'ada@codeforge.dev', user_id: 'u1', api_base: 'https://www.codeforge.dev' })
  const http = jest.fn(async (url: string) => {
    expect(url).toBe('https://www.codeforge.dev/api/runtime/v1/models')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        default_model: 'codeforge-lite',
        data: [
          { id: 'codeforge-lite', name: 'CodeForge-Lite', owned_by: 'codeforge' },
          { id: 'codeforge-pro', name: 'CodeForge-Pro', owned_by: 'codeforge' },
        ],
      }),
      text: async () => '',
    }
  })
  try {
    const name = await resolveRuntimeModel(http)
    expect(name).toBe('codeforge-lite')
    expect(name).not.toBe('codeforge-default')
    expect(readSession().last_model).toBe('codeforge-lite')
    expect(http).toHaveBeenCalledTimes(1)
  } finally {
    if (previous === undefined) delete process.env.CODEFORGE_HOME
    else process.env.CODEFORGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})
