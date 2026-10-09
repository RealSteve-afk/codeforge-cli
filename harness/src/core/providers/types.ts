import type { PlanItem, ToolDef } from '../tools'
import type { WebHit } from '../store'

// Events streamed from a running turn to every attached client (GUI, TUI).
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'approval'; approvalId: string; toolCallId: string; name: string; input: unknown }
  | { type: 'approval_resolved'; approvalId: string; allowed: boolean }
  | { type: 'notice'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  // Short notes the model writes between tool calls ("found X, now doing Y").
  | { type: 'progress'; text: string }
  // Ephemeral "what is happening right now" line; not saved in the transcript.
  | { type: 'status'; text: string }
  | { type: 'web'; id: string; action: 'search' | 'fetch'; query?: string; url?: string }
  | { type: 'web_result'; id: string; results?: WebHit[]; url?: string; title?: string; error?: string }
  | { type: 'plan'; items: PlanItem[] }
  | { type: 'question'; questionId: string; question: string; options: string[]; allowText: boolean }
  | { type: 'question_resolved'; questionId: string; answer: string }
  | { type: 'summary'; seconds: number; steps: number; stopReason: string; inputTokens: number; outputTokens: number }
  | { type: 'done'; stopReason: string }

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ToolOutcome {
  id: string
  output: string
  isError: boolean
}

export interface TurnContext {
  // Provider-native message history. Providers only append to it.
  history: unknown[]
  // Marks the history as consistent (safe to replay). On failure the agent
  // rolls the history back to the last commit.
  commit(): void
  system: string
  tools: ToolDef[]
  runTools(calls: ToolCall[]): Promise<ToolOutcome[]>
  emit(event: AgentEvent): void
  signal: AbortSignal
  // Whether the user allowed web access for this session.
  web: boolean
}

export interface Provider {
  // True when the provider searches the web itself (server-side tools), so the
  // agent should not add its own client-side web tools.
  readonly builtInWeb: boolean
  // Runs one user turn through as many model/tool steps as needed and returns the final stop reason.
  runTurn(userText: string, ctx: TurnContext): Promise<string>
}

export const MAX_STEPS_PER_TURN = 100
