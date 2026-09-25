import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'
import { analysisStore } from './analysis-store.js'

/**
 * analyze_codebase：开始代码库分析（对齐设计文档 6.7）。
 * 开启分析会话后，LLM 应自行用文件工具浏览代码，并用 record_analysis 记录发现。
 */

export const analyzeCodebaseSpec: ToolSpec = {
  name: 'analyze_codebase',
  description:
    '开始一次代码库分析会话。target 指定分析范围（如 "src/llm" 或 "整个仓库"）。开启后请自行用 read_file/list_directory/glob 浏览代码，并用 record_analysis 逐条记录发现（架构、依赖、风险等），最后 finish_analysis 收尾。',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: '分析范围（相对路径或"整个仓库"）' },
    },
    required: ['target'],
  },
  dangerLevel: 'low',
}

export const analyzeCodebaseHandler: ToolHandler = async (args, ctx) => {
  const target = argString(args.arguments, 'target')
  if (!target) return fail('缺少参数 target（分析范围）')

  try {
    const store = analysisStore(ctx.workingDir)
    const session = await store.start(target)
    return {
      success: true,
      content:
        `分析会话已开启: ${session.id}（目标: ${session.target}）\n` +
        `已记录 ${session.records.length} 条发现。\n` +
        '接下来：用文件工具浏览目标代码 → record_analysis 记录发现 → finish_analysis 收尾。',
      restartRequested: false,
    }
  } catch (e) {
    return fail(`开始分析失败: ${e instanceof Error ? e.message : String(e)}`)
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
