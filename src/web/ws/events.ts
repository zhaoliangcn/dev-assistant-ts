import type { AgentEvent } from '../../agent/agent.js'

/**
 * WebSocket 事件类型（对齐设计文档 12.2 协议）。
 *
 * 客户端 → 服务端：
 * - { type: 'user_message', content, id? }
 * - { type: 'cancel', messageId? }
 *
 * 服务端 → 客户端：见 ServerEvent。
 */

export interface ClientMessage {
  type: 'user_message' | 'cancel'
  content?: string
  id?: string
  messageId?: string
}

export type ServerEvent =
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; toolName: string; args: string }
  | { type: 'tool_result'; toolName: string; success: boolean; content: string }
  | { type: 'assistant_stream_delta'; delta: string; isFinal: boolean }
  | { type: 'reasoning_delta'; delta: string; isFinal: boolean }
  | { type: 'assistant_message'; content: string; streaming?: boolean }
  | { type: 'token_usage'; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: 'error'; content: string }
  | { type: 'status'; content: string }
  | { type: 'session_ready'; sessionId: string }
  | { type: 'done'; messageId?: string }

/**
 * Agent 流式事件 → WS ServerEvent 映射（纯函数，可单测）。
 * 返回 null 表示该事件不向客户端推送。
 */
export function agentEventToWsEvent(
  event: AgentEvent,
  ctx: { assistantSoFar: string },
): ServerEvent | null {
  switch (event.kind) {
    case 'assistantStreamDelta':
      ctx.assistantSoFar += event.content
      return { type: 'assistant_stream_delta', delta: event.content, isFinal: false }
    case 'reasoningDelta':
      return { type: 'reasoning_delta', delta: event.content, isFinal: false }
    case 'toolCall':
      return { type: 'tool_call', toolName: event.call.function.name, args: event.call.function.arguments }
    case 'toolResult':
      return { type: 'tool_result', toolName: event.name, success: event.result.success, content: event.result.content }
    case 'status':
      return { type: 'status', content: event.content }
    case 'tokenUsage':
      return {
        type: 'token_usage',
        promptTokens: event.usage.promptTokens,
        completionTokens: event.usage.completionTokens,
        totalTokens: event.usage.totalTokens,
      }
    case 'systemMessage':
      return { type: 'status', content: event.content }
    default:
      return null
  }
}

/** 最终消息事件（app.run 完成后推送） */
export function finalAssistantEvent(content: string, messageId?: string): ServerEvent[] {
  const events: ServerEvent[] = [{ type: 'assistant_message', content, streaming: false }]
  if (content.length > 0) {
    events.unshift({ type: 'assistant_stream_delta', delta: '', isFinal: true })
  }
  events.push({ type: 'done', messageId })
  return events
}
