import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argNumber } from '../common.js'
import { analysisStore } from './analysis-store.js'

/**
 * get_analysis_summary：查看当前分析会话进度（对齐设计文档 6.7）。
 * 返回会话状态、已记录条数、发现标题列表、最近几条详情。
 */

export const getAnalysisSummarySpec: ToolSpec = {
  name: 'get_analysis_summary',
  description:
    '查看当前分析会话进度：状态、已记录发现条数与标题清单、最近几条详情。用于自检"还差哪些没记"或回顾已记录内容。',
  parameters: {
    type: 'object',
    properties: {
      recent: { type: 'integer', description: '展示最近几条发现的详情（默认 3，上限 10）' },
    },
  },
  dangerLevel: 'low',
}

export const getAnalysisSummaryHandler: ToolHandler = async (args, ctx) => {
  try {
    const store = analysisStore(ctx.workingDir)
    const session = await store.current()
    if (!session) {
      return ok('当前没有分析会话。先用 analyze_codebase 开启。')
    }

    const recent = Math.min(10, Math.max(0, argNumber(args.arguments, 'recent') ?? 3))
    const lines: string[] = [
      `分析会话: ${session.id}`,
      `目标: ${session.target}`,
      `状态: ${session.status}`,
      `发现条数: ${session.records.length}`,
      `创建: ${session.createdAt} · 更新: ${session.updatedAt}`,
    ]

    if (session.records.length > 0) {
      lines.push('', '发现清单:')
      session.records.forEach((r, i) => {
        lines.push(`  ${i + 1}. ${r.title}（${r.at.slice(0, 16).replace('T', ' ')}）`)
      })
      if (recent > 0) {
        lines.push('', '最近详情:')
        for (const r of session.records.slice(-recent)) {
          const content = r.content.length > 300 ? `${r.content.slice(0, 300)}…` : r.content
          lines.push(`- 【${r.title}】${content}`)
        }
      }
    }

    if (session.status === 'completed') {
      lines.push('', '（会话已完成，可用 finish_analysis 的结果或重新 analyze_codebase 开始新分析）')
    } else if (session.status === 'abandoned') {
      lines.push('', '（该会话已中断；重新 analyze_codebase 可开启新分析）')
    }

    return ok(lines.join('\n'))
  } catch (e) {
    return fail(`获取分析摘要失败: ${e instanceof Error ? e.message : String(e)}`)
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
