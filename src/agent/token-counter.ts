import type { LlmMessage, ToolCall } from '../llm/models.js'

/**
 * Token 估算（设计文档附录 A.1）。
 *
 * 简单估算：
 * - ASCII/英文：约 4 字符 ≈ 1 token
 * - CJK（中日韩）：约 1.5 字 ≈ 1 token
 *
 * 混合文本按字符类别分别累计。Phase 3 可替换为 gpt-tokenizer 精确计数。
 */

/** 估算单个字符串的 token 数 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // CJK 统一表意文字（含扩展 A）、日文假名、全角标点
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++
    } else {
      other++
    }
  }
  return Math.ceil(cjk / 1.5 + other / 4)
}

/** 估算一条消息的 token 数（含 role 开销与 tool_call 结构开销） */
export function estimateMessageTokens(message: LlmMessage): number {
  let tokens = 4 // role + 结构开销
  tokens += estimateTokens(message.content ?? '')
  if (message.toolCallId) tokens += 4
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      tokens += estimateToolCallTokens(call)
    }
  }
  return tokens
}

/** 估算单个工具调用的 token 数 */
export function estimateToolCallTokens(call: ToolCall): number {
  return 8 + estimateTokens(call.id) + estimateTokens(call.function.name) + estimateTokens(call.function.arguments)
}

/** 估算整个消息列表 */
export function estimateMessagesTokens(messages: LlmMessage[]): number {
  let total = 3 // messages 数组本身开销
  for (const m of messages) {
    total += estimateMessageTokens(m)
  }
  return total
}

/** 估算工具 schema 列表的 token 数（随请求重复发送） */
export function estimateToolsTokens(tools: Array<{ name: string; description: string; parameters: object }>): number {
  let total = 0
  for (const t of tools) {
    total += 6 + estimateTokens(t.name) + estimateTokens(t.description)
    total += estimateTokens(JSON.stringify(t.parameters))
  }
  return total
}
