import type { ToolDef } from '../tools'

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
}

export interface Provider {
  // Runs one user turn through as many model/tool steps as needed and returns the final stop reason.
  runTurn(userText: string, ctx: TurnContext): Promise<string>
}

export const MAX_STEPS_PER_TURN = 100
