import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'
import { summarizeMessages, estimateMessagesTokensForSummary } from '../../agent/summary.js'
import { nowIso } from '../../persist/events.js'

/**
 * save_summary：手动保存阶段性摘要（默认对最近 N 条消息）。
 * 与主循环周期性摘要同一实现；摘要持久化为 summary_saved 事件（崩溃恢复用）。
 */

export const saveSummarySpec: ToolSpec = {
  name: 'save_summary',
  description:
    '手动保存当前会话阶段性摘要（默认覆盖最近 15 条消息，count 可调）。摘要落盘后进程崩溃可恢复要点。note 可附注摘要主题。',
  parameters: {
    type: 'object',
    properties: {
      count: { type: 'integer', description: '摘要覆盖的最近消息条数（默认 15，上限 50）' },
      note: { type: 'string', description: '摘要主题附注（可选）' },
    },
  },
  dangerLevel: 'low',
}

export const saveSummaryHandler: ToolHandler = async (args, ctx) => {
  const agent = ctx.agent
  if (!agent) {
    return fail('save_summary 只能在 Agent 运行上下文中使用')
  }

  const count = Math.min(50, Math.max(1, Number(args.arguments.count ?? 15)))
  const note = argString(args.arguments, 'note')

  const context = agent.getContext()
  // 只摘要对话消息（system 提示词不参与摘要）
  const dialog = context.toMessages().filter((m) => m.role !== 'system')
  if (dialog.length === 0) {
    return fail('当前上下文无对话消息，无可摘要内容')
  }
  const tail = dialog.slice(-count)

  try {
    let summary = await summarizeMessages(tail, agent.llm)
    if (note) {
      summary = `【主题: ${note}】\n${summary}`
    }
    const tokens = estimateMessagesTokensForSummary(tail)
    agent.sessionStore.append({
      type: 'summary_saved',
      timestamp: nowIso(),
      sessionId: agent.sessionId,
      level: 1,
      content: summary,
    })

    const preview = summary.length > 400 ? `${summary.slice(0, 400)}\n…（已截断）` : summary
    return ok(`摘要已保存（覆盖最近 ${tail.length} 条消息 / 约 ${tokens} tokens）\n---\n${preview}`)
  } catch (e) {
    return fail(`摘要保存失败: ${e instanceof Error ? e.message : String(e)}`)
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
