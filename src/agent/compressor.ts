import type { LlmClient } from '../llm/client.js'
import type { LlmMessage } from '../llm/models.js'
import type { ContextManager } from './context.js'
import { estimateMessagesTokens } from './token-counter.js'
import { summarizeMessages } from './summary.js'
import { log } from '../utils/logger.js'

/**
 * 上下文压缩（对齐设计文档 8.3）。
 *
 * 策略：
 * - 保留全部 system 消息（含已注入的压缩摘要/记忆）
 * - 最近 recentCount 条消息原样保留（至少 4 条，或总数 20%）
 * - 中间较早消息 → LLM 生成摘要 → 作为一条 system 消息前置
 *
 * 触发条件由 Agent 主循环决定（budget.pressure === 'critical' 或 compress_context 工具）。
 * 压缩前后 token 数通过 context_compression 事件持久化（由调用方落盘）。
 */

export interface CompressionResult {
  beforeTokens: number
  afterTokens: number
  /** 被压缩（蒸馏为摘要）的消息条数 */
  compressedCount: number
  /** 保留的近期消息条数 */
  keptRecentCount: number
  summary: string
  /** 摘要 LLM 调用失败时降级为本地摘要（true = 降级） */
  degraded: boolean
}

/**
 * 压缩上下文。
 * @param context ContextManager（会被原地 resetAndRebuild）
 * @param llm 用于生成摘要的 LLM 客户端
 */
export async function compressContext(
  context: ContextManager,
  llm: LlmClient,
): Promise<CompressionResult> {
  const beforeTokens = context.totalTokens()
  const messages = context.toMessages()

  // 分离 system 消息与非 system 消息
  const systemMsgs = messages.filter((m) => m.role === 'system')
  const body = messages.filter((m) => m.role !== 'system')

  // 消息太少，压缩无意义
  if (body.length <= 4) {
    return {
      beforeTokens,
      afterTokens: beforeTokens,
      compressedCount: 0,
      keptRecentCount: body.length,
      summary: '',
      degraded: false,
    }
  }

  const recentCount = Math.max(4, Math.floor(body.length * 0.2))
  const older = body.slice(0, body.length - recentCount)
  const recent = body.slice(body.length - recentCount)

  // 摘要生成（失败时 summary.ts 内部降级为本地摘要）
  const llmSummary = await summarizeMessages(older, llm)
  const degraded = llmSummary.startsWith('[摘要生成失败')
  const summary = `以下是本次会话早前内容的压缩摘要（压缩前 ${beforeTokens} tokens，蒸馏自 ${older.length} 条消息）：\n${llmSummary}`

  // 重建上下文：system + 摘要 + 近期消息
  // 注意：旧的 system 消息中若已有"压缩摘要"，保留（分层叠加）
  const rebuilt: LlmMessage[] = [...systemMsgs, { role: 'system', content: summary }, ...recent]
  context.resetAndRebuild([], rebuilt)
  // resetAndRebuild 会重算 token（含 tools 固定开销）

  const afterTokens = context.totalTokens()
  log.info('上下文压缩完成', {
    beforeTokens,
    afterTokens,
    saved: beforeTokens - afterTokens,
    compressedCount: older.length,
    keptRecentCount: recent.length,
    degraded,
  })

  return {
    beforeTokens,
    afterTokens,
    compressedCount: older.length,
    keptRecentCount: recent.length,
    summary,
    degraded,
  }
}

/** 判断是否值得压缩（避免对极小上下文做无谓压缩） */
export function isCompressionWorthwhile(context: ContextManager, minRatio = 0.6): boolean {
  const budget = context.budget()
  const body = context.toMessages().filter((m) => m.role !== 'system')
  return budget.ratio >= minRatio && body.length > 4
}

/** 估算压缩后 token（供 context_budget 工具展示，不实际执行） */
export function previewCompression(context: ContextManager): { olderCount: number; recentCount: number } {
  const body = context.toMessages().filter((m) => m.role !== 'system')
  const recentCount = Math.max(4, Math.floor(body.length * 0.2))
  return { olderCount: body.length - recentCount, recentCount }
}

export { estimateMessagesTokens }
