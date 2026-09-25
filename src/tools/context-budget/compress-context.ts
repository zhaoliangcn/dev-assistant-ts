import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { compressContext, isCompressionWorthwhile, previewCompression } from '../../agent/compressor.js'
import { nowIso } from '../../persist/events.js'

/**
 * compress_context：手动触发上下文压缩（LLM 主动决定何时压缩）。
 * 与主循环 critical 自动压缩同一实现；压缩事件持久化为 context_compression。
 */

export const compressContextToolSpec: ToolSpec = {
  name: 'compress_context',
  description:
    '手动压缩当前上下文：较早消息被蒸馏为摘要，近期消息保留。当 context_budget 显示压力大或预计还有长任务时主动调用。',
  parameters: {
    type: 'object',
    properties: {},
  },
  dangerLevel: 'low',
}

export const compressContextToolHandler: ToolHandler = async (_args, ctx) => {
  const agent = ctx.agent
  if (!agent) {
    return fail('compress_context 只能在 Agent 运行上下文中使用')
  }

  const context = agent.getContext()
  if (!isCompressionWorthwhile(context, 0.3)) {
    const budget = context.budget()
    const preview = previewCompression(context)
    return ok(
      `当前上下文较小（${budget.current}/${budget.max} tokens，${(budget.ratio * 100).toFixed(1)}%），压缩收益有限，已跳过。` +
        `（若强制压缩：蒸馏 ${preview.olderCount} 条，保留最近 ${preview.recentCount} 条）`,
    )
  }

  try {
    const cr = await compressContext(context, agent.llm)
    // 持久化压缩事件
    agent.sessionStore.append({
      type: 'context_compression',
      timestamp: nowIso(),
      sessionId: agent.sessionId,
      beforeTokens: cr.beforeTokens,
      afterTokens: cr.afterTokens,
    })

    return ok(
      `压缩完成: ${cr.beforeTokens} → ${cr.afterTokens} tokens（节省 ${cr.beforeTokens - cr.afterTokens}）\n` +
        `蒸馏 ${cr.compressedCount} 条较早消息为摘要，保留最近 ${cr.keptRecentCount} 条` +
        (cr.degraded ? '\n⚠️ LLM 摘要失败，已使用本地降级摘要（信息损失较大）' : ''),
    )
  } catch (e) {
    return fail(`压缩失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function ok(content: string) {
  return { success: true as const, content, restartRequested: false as const }
}
function fail(message: string) {
  return {
    success: false as const,
    content: message,
    restartRequested: false as const,
    errorCategory: 'permanent' as const,
  }
}
