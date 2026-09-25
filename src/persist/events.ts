/**
 * 会话持久化事件（对齐设计文档 5.4，与 dev-assistant-rs 事件枚举一致）。
 * JSONL 每行一个事件。
 */

export type SessionEvent =
  | { type: 'user_message'; timestamp: string; sessionId: string; content: string }
  | { type: 'assistant_message'; timestamp: string; sessionId: string; content: string }
  | { type: 'system_message'; timestamp: string; sessionId: string; content: string }
  | {
      type: 'tool_call_request'
      timestamp: string
      sessionId: string
      toolCallId: string
      name: string
      arguments: unknown
    }
  | {
      type: 'tool_result'
      timestamp: string
      sessionId: string
      toolCallId: string
      name: string
      success: boolean
      content: string
    }
  | {
      type: 'context_compression'
      timestamp: string
      sessionId: string
      beforeTokens: number
      afterTokens: number
    }
  | { type: 'summary_saved'; timestamp: string; sessionId: string; level: number; content: string }

/** 当前时间 ISO 字符串 */
export function nowIso(): string {
  return new Date().toISOString()
}
