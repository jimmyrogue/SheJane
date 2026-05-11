import type { ToolDefinition } from '../types.js'

export interface HarnessMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoningContent?: string
  toolCallId?: string
  name?: string
  toolCalls?: LLMToolCall[]
}

export interface LLMToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface LLMGatewayRequest {
  runId: string
  mode?: string
  messages: HarnessMessage[]
  tools: ToolDefinition[]
}

export interface LLMGatewayResponse {
  requestId?: string
  content?: string
  reasoningContent?: string
  toolCalls?: LLMToolCall[]
}

export interface LLMGateway {
  call(request: LLMGatewayRequest): Promise<LLMGatewayResponse>
}

export class StaticLLMGateway implements LLMGateway {
  async call(): Promise<LLMGatewayResponse> {
    return {
      requestId: 'local-static',
      content: 'Local Agent Harness loop is online. Configure the cloud LLM gateway to enable model-driven tool calls.',
    }
  }
}
