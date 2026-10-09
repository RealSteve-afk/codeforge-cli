import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { PublicProfile } from '../store'

// Claude models that return short progress updates between tool calls
// (thinking.display "updates").
const PROGRESS_UPDATE_MODELS = /^claude-(fable-5|fable-5-1|mythos-5-1|opus-5-5|sonnet-5-5)$/
// Claude models with the dynamic-filtering web tools (web_search/web_fetch _20260209).
const DYNAMIC_WEB_MODELS = /^claude-(opus-(4-[678]|5|5-5)|sonnet-(4-6|5|5-5)|fable-5|fable-5-1|mythos-5|mythos-5-1)$/

export function supportsProgressUpdates(model: string): boolean {
  return PROGRESS_UPDATE_MODELS.test(model)
}

export function supportsDynamicWebTools(model: string): boolean {
  return DYNAMIC_WEB_MODELS.test(model)
}

const cache = new Map<string, { at: number; models: string[] }>()
const CACHE_MS = 10 * 60 * 1000

// Lists the models a profile's account can use, via the provider's Models API.
export async function listProviderModels(profile: PublicProfile, apiKey: string | undefined): Promise<string[]> {
  const key = `${profile.id}:${profile.baseUrl ?? ''}:${profile.apiKeyHint ?? ''}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.models
  const ids: string[] = []
  if (profile.provider === 'anthropic') {
    const client = new Anthropic({ apiKey, baseURL: profile.baseUrl || undefined, timeout: 15_000 })
    for await (const model of client.models.list()) {
      ids.push(model.id)
      if (ids.length >= 200) break
    }
  } else {
    const client = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: profile.baseUrl || undefined, timeout: 15_000 })
    for await (const model of client.models.list()) {
      ids.push(model.id)
      if (ids.length >= 500) break
    }
    ids.sort()
  }
  cache.set(key, { at: Date.now(), models: ids })
  return ids
}
