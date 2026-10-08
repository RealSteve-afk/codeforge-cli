export type ToolName = 'read_file' | 'search_replace' | 'grep' | 'bash'

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ModelCompletion {
  text: string
  tool_calls: ToolCall[]
}

export interface ModelRequest {
  model: string
  messages: ModelMessage[]
  tools: ToolDefinition[]
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelCompletion>
}

export interface ToolResult {
  id: string
  name: string
  content: string
  ok: boolean
}

export interface LocalTurnEvent {
  type: 'text' | 'tool' | 'error' | 'status' | 'bound'
  text?: string
}

export interface LocalTurnResult {
  conversationId: string
  text: string
  toolResults: ToolResult[]
  requests: ModelRequest[]
}
