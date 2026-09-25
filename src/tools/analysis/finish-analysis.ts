import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'
import { analysisStore } from './analysis-store.js'

/**
 * finish_analysis：完成分析会话（对齐设计文档 6.7）。
 * 收尾：状态转 completed，汇总全部发现供 LLM 写入最终回复。
 */

export const finishAnalysisSpec: ToolSpec = {
  name: 'finish_analysis',
  description:
    '完成当前分析会话（状态转 completed）。返回全部已记录发现的汇总，用于撰写最终分析结论。无发现时拒绝收尾（提示先 record_analysis）。',
  parameters: {
    type: 'object',
    properties: {
      conclusion: { type: 'string', description: '可选：一句话分析结论（附在汇总末尾）' },
    },
  },
  dangerLevel: 'low',
}

export const finishAnalysisHandler: ToolHandler = async (args, ctx) => {
  try {
    const store = analysisStore(ctx.workingDir)
    const existing = await store.current()
    if (!existing) {
      return fail('没有进行中的分析会话（先调用 analyze_codebase）')
    }
    if (existing.status === 'completed') {
      return ok(`分析会话 ${existing.id} 已完成（${existing.records.length} 条发现）。`)
    }
    if (existing.status === 'abandoned') {
      return fail(`分析会话 ${existing.id} 已中断，无法收尾；请重新 analyze_codebase。`)
    }
    if (existing.records.length === 0) {
      return fail('分析会话还没有任何发现（record_analysis），无法收尾。')
    }

    const session = await store.finish()
    const conclusion = argString(args.arguments, 'conclusion')

    const blocks = session.records.map(
      (r, i) => `### ${i + 1}. ${r.title}\n${r.content}`,
    )
    const lines = [
      `分析完成: ${session.id}（目标 ${session.target}，共 ${session.records.length} 条发现）`,
      '',
      '发现汇总:',
      ...blocks,
    ]
    if (conclusion) {
      lines.push('', `结论: ${conclusion}`)
    }
    return {
      success: true,
      content: lines.join('\n\n'),
      restartRequested: false,
    }
  } catch (e) {
    return fail(`完成分析失败: ${e instanceof Error ? e.message : String(e)}`)
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
