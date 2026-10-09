import OpenAI from 'openai'
import type { Effort } from '../store'
import { toolInputSchema } from '../tools'
import { MAX_STEPS_PER_TURN, type Provider, type ToolCall, type TurnContext } from './types'

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

// Works with OpenAI and any OpenAI-compatible server (Ollama, vLLM, LM Studio, OpenRouter, ...).
export interface OpenAIOptions {
  apiKey?: string
  model: string
  baseUrl?: string
  effort?: Effort
}

export function openaiProvider(options: OpenAIOptions, client?: OpenAI): Provider {
  const api = client ?? new OpenAI({ apiKey: options.apiKey || 'not-needed', baseURL: options.baseUrl || undefined })
  const reasoningEffort = options.effort ? (options.effort === 'xhigh' || options.effort === 'max' ? 'high' : options.effort) : undefined

  return {
    builtInWeb: false,
    async runTurn(userText: string, ctx: TurnContext): Promise<string> {
      const history = ctx.history as ChatMessage[]
      if (history.length === 0) history.push({ role: 'system', content: ctx.system })
      history.push({ role: 'user', content: userText })
      const tools = ctx.tools.map((tool) => ({
        type: 'function' as const,
        function: { name: tool.name, description: tool.description, parameters: toolInputSchema(tool) },
      }))

      for (let step = 0; step < MAX_STEPS_PER_TURN; step += 1) {
        const stream = await api.chat.completions.create(
          {
            model: options.model,
            messages: history,
            tools,
            stream: true,
            stream_options: { include_usage: true },
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          },
          { signal: ctx.signal },
        )
        let text = ''
        let finish = ''
        const pending: Array<{ id: string; name: string; args: string }> = []
        for await (const chunk of stream) {
          if (chunk.usage) {
            ctx.emit({ type: 'usage', inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens })
          }
          const choice = chunk.choices[0]
          if (!choice) continue
          if (choice.delta.content) {
            text += choice.delta.content
            ctx.emit({ type: 'text', text: choice.delta.content })
          }
          for (const call of choice.delta.tool_calls ?? []) {
            const slot = (pending[call.index] ??= { id: '', name: '', args: '' })
            if (call.id) slot.id = call.id
            if (call.function?.name) slot.name += call.function.name
            if (call.function?.arguments) slot.args += call.function.arguments
          }
          if (choice.finish_reason) finish = choice.finish_reason
        }

        const calls = pending.filter(Boolean)
        if (calls.length === 0) {
          history.push({ role: 'assistant', content: text })
          ctx.commit()
          return finish || 'stop'
        }
        if (finish === 'length') {
          ctx.emit({ type: 'error', message: 'the response hit the length limit in the middle of a tool call' })
          return 'length'
        }

        history.push({
          role: 'assistant',
          content: text || null,
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
        })
        const toolCalls: ToolCall[] = calls.map((c) => ({ id: c.id, name: c.name, input: parseArgs(c.args) }))
        const outcomes = await ctx.runTools(toolCalls)
        for (const outcome of outcomes) {
          history.push({ role: 'tool', tool_call_id: outcome.id, content: outcome.isError ? `ERROR: ${outcome.output}` : outcome.output })
        }
        ctx.commit()
      }
      ctx.emit({ type: 'notice', text: `stopped after ${MAX_STEPS_PER_TURN} steps` })
      return 'max_steps'
    },
  }
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return { INVALID_JSON: raw }
  }
}
