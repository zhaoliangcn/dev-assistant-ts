import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'
import { analysisStore } from './analysis-store.js'

/**
 * record_analysis：记录一条分析发现（对齐设计文档 6.7）。
 */

export const recordAnalysisSpec: ToolSpec = {
  name: 'record_analysis',
  description:
    '在当前分析会话中记录一条发现（title 概括 + content 详述）。逐条记录架构、模块职责、依赖关系、风险点等；会话结束前用 finish_analysis 收尾。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '发现标题（如"LLM 层采用多 provider 故障转移"）' },
      content: { type: 'string', description: '发现详情（含文件路径、关键标识符）' },
    },
    required: ['title', 'content'],
  },
  dangerLevel: 'low',
}

export const recordAnalysisHandler: ToolHandler = async (args, ctx) => {
  const title = argString(args.arguments, 'title')
  const content = argString(args.arguments, 'content')
  if (!title) return fail('缺少参数 title（发现标题）')
  if (!content) return fail('缺少参数 content（发现详情）')

  try {
    const store = analysisStore(ctx.workingDir)
    const session = await store.record(title, content)
    return {
      success: true,
      content: `已记录第 ${session.records.length} 条发现: ${title}\n（会话 ${session.id} 共 ${session.records.length} 条）`,
      restartRequested: false,
    }
  } catch (e) {
    return fail(`记录分析失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function fail(message: string) {
  return {
    success: false as const,
    content: message,
    restartRequested: false as const,
    errorCategory: 'permanent' as const,
  }
}
