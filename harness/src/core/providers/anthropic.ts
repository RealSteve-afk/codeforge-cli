import Anthropic from '@anthropic-ai/sdk'
import type { Effort } from '../store'
import { toolInputSchema } from '../tools'
import { MAX_STEPS_PER_TURN, type Provider, type ToolCall, type TurnContext } from './types'

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam
type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam

// Models that accept the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const MAX_JSON_RETRIES = 2

export interface AnthropicOptions {
  apiKey: string
  model: string
  baseUrl?: string
  effort?: Effort
  thinking: boolean
  fallbacks: boolean
}

export function anthropicProvider(options: AnthropicOptions, client?: Anthropic): Provider {
  const api = client ?? new Anthropic({ apiKey: options.apiKey, baseURL: options.baseUrl || undefined })
  const useFallbacks = options.fallbacks && !options.baseUrl && FALLBACK_MODELS.has(options.model)

  return {
    async runTurn(userText: string, ctx: TurnContext): Promise<string> {
      const history = ctx.history as BetaMessageParam[]
      history.push({ role: 'user', content: userText })
      // Streamed tool inputs are validated by the agent before any tool runs.
      const tools = ctx.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: toolInputSchema(tool) as Anthropic.Beta.Messages.BetaTool['input_schema'],
        eager_input_streaming: true,
      }))
      let jsonRetries = 0

      for (let step = 0; step < MAX_STEPS_PER_TURN; step += 1) {
        const stream = api.beta.messages.stream(
          {
            model: options.model,
            max_tokens: 64000,
            system: ctx.system,
            cache_control: { type: 'ephemeral' },
            tools,
            messages: history,
            ...(options.thinking ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } } : {}),
            ...(options.effort ? { output_config: { effort: options.effort } } : {}),
            ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
          },
          { signal: ctx.signal },
        )

        let message: BetaMessage
        try {
          for await (const event of stream) {
            if (event.type !== 'content_block_delta') continue
            if (event.delta.type === 'text_delta') ctx.emit({ type: 'text', text: event.delta.text })
            else if (event.delta.type === 'thinking_delta') ctx.emit({ type: 'thinking', text: event.delta.thinking })
          }
          message = await stream.finalMessage()
          jsonRetries = 0
        } catch (error) {
          // Only a tool input that could not be parsed at all is retried; API
          // errors (auth, rate limit, abort, ...) go to the caller.
          if (error instanceof Anthropic.APIError || jsonRetries >= MAX_JSON_RETRIES) throw error
          jsonRetries += 1
          ctx.emit({ type: 'notice', text: 'model produced unparseable tool input; retrying the step' })
          continue
        }

        ctx.emit({ type: 'usage', inputTokens: totalInput(message.usage), outputTokens: message.usage.output_tokens })
        for (const block of message.content) {
          if (block.type === 'fallback') ctx.emit({ type: 'notice', text: `${block.from.model} declined; continued on ${block.to.model}` })
        }

        if (message.stop_reason === 'refusal') {
          const category = message.stop_details?.category
          ctx.emit({ type: 'notice', text: `the model declined this request${category ? ` (${category})` : ''}` })
          return 'refusal'
        }
        if (message.stop_reason === 'pause_turn') {
          history.push({ role: 'assistant', content: message.content })
          continue
        }

        const toolUses = message.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use')
        if (toolUses.length === 0) {
          history.push({ role: 'assistant', content: message.content })
          ctx.commit()
          return message.stop_reason ?? 'end_turn'
        }
        if (message.stop_reason === 'max_tokens') {
          // A truncated tool input can still look valid; never run it.
          ctx.emit({ type: 'error', message: 'the response hit max_tokens in the middle of a tool call' })
          return 'max_tokens'
        }

        history.push({ role: 'assistant', content: message.content })
        const calls: ToolCall[] = toolUses.map((b) => ({ id: b.id, name: b.name, input: b.input }))
        const outcomes = await ctx.runTools(calls)
        const results: BetaToolResultBlockParam[] = outcomes.map((o) => ({
          type: 'tool_result',
          tool_use_id: o.id,
          content: o.output,
          ...(o.isError ? { is_error: true } : {}),
        }))
        // All results for one assistant turn go back in a single user message.
        history.push({ role: 'user', content: results })
        ctx.commit()
      }
      ctx.emit({ type: 'notice', text: `stopped after ${MAX_STEPS_PER_TURN} steps` })
      return 'max_steps'
    },
  }
}

function totalInput(usage: BetaMessage['usage']): number {
  return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
}
