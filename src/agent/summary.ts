import type { LlmClient } from '../llm/client.js'
import type { LlmMessage } from '../llm/models.js'
import { estimateMessageTokens } from './token-counter.js'

/**
 * 分层摘要（对齐设计文档 8.1 步骤 7 + 决策 6：save_summary 每 5 轮一次）。
 *
 * 两个用途：
 * 1. 周期性摘要（saveSummary）：把最近一批消息蒸馏成简短摘要并落盘（summary_saved 事件），
 *    供进程崩溃后恢复对话要点使用；
 * 2. 压缩摘要（summarizeMessages）：compressor 压缩上下文时对"较早消息"生成总结。
 */

/** 摘要提示词（要求 LLM 输出结构化要点） */
const SUMMARY_PROMPT = `你是对话摘要器。请把下面的对话/操作历史压缩为简短的中文摘要，要求：
1. 用"目标 / 已完成 / 关键决策 / 未决事项"四段（没有的段写"无"）
2. 保留文件路径、函数名、命令、错误信息等关键标识符
3. 总长控制在 600 字以内
4. 只输出摘要本身，不要任何额外说明`

export interface SummaryOptions {
  /** 摘要级别（分层：1=轮次摘要，2=会话级大摘要） */
  level?: number
  /** 摘要输入的消息列表 */
  messages: LlmMessage[]
}

/**
 * 调用 LLM 生成摘要文本。
 * 摘要请求不带工具（防止摘要器又去调工具），失败时降级为本地截断摘要。
 */
export async function summarizeMessages(messages: LlmMessage[], llm: LlmClient): Promise<string> {
  if (messages.length === 0) return '（空）'

  const history = messages
    .map((m) => renderMessageForSummary(m))
    .filter(Boolean)
    .join('\n')

  const truncated = history.length > 60_000 ? `${history.slice(0, 60_000)}\n…（历史过长已截断）` : history
  const requestMessages: LlmMessage[] = [
    { role: 'user', content: `${SUMMARY_PROMPT}\n\n对话历史：\n${truncated}` },
  ]

  try {
    const res = await llm.call(requestMessages, [])
    if (res.kind === 'text' && res.content.trim().length > 0) {
      return res.content.trim()
    }
  } catch (e) {
    // 降级：本地截断摘要（保证压缩流程不因摘要失败而中断）
    const msg = e instanceof Error ? e.message : String(e)
    return `[摘要生成失败: ${msg}]\n${localFallbackSummary(messages)}`
  }
  return localFallbackSummary(messages)
}

/** 本地降级摘要：不调 LLM，直接截取关键消息内容 */
function localFallbackSummary(messages: LlmMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'user') lines.push(`用户: ${clip(m.content ?? '', 200)}`)
    else if (m.role === 'assistant') {
      if (m.content) lines.push(`助手: ${clip(m.content, 200)}`)
      if (m.toolCalls) {
        for (const c of m.toolCalls) lines.push(`助手调用: ${c.function.name}(${clip(c.function.arguments, 120)})`)
      }
    } else if (m.role === 'tool') {
      lines.push(`工具结果: ${clip(m.content ?? '', 120)}`)
    }
  }
  return `（本地摘要，LLM 不可用）\n${lines.join('\n')}`
}

/** 单条消息的摘要用渲染（控制单条长度） */
function renderMessageForSummary(m: LlmMessage): string {
  if (m.role === 'system') return ''
  if (m.role === 'user') return `用户: ${clip(m.content ?? '', 1500)}`
  if (m.role === 'assistant') {
    const parts: string[] = []
    if (m.content) parts.push(`助手: ${clip(m.content, 1500)}`)
    if (m.toolCalls) {
      for (const c of m.toolCalls) parts.push(`助手调用: ${c.function.name}(${clip(c.function.arguments, 300)})`)
    }
    return parts.join(' | ')
  }
  if (m.role === 'tool') return `工具结果(${m.toolCallId ?? '?'}): ${clip(m.content ?? '', 800)}`
  return ''
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 估算一批消息的 token 数（saveSummary 日志/事件用） */
export function estimateMessagesTokensForSummary(messages: LlmMessage[]): number {
  let total = 0
  for (const m of messages) total += estimateMessageTokens(m)
  return total
}
