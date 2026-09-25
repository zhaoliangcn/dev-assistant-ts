import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'

/**
 * finish：标记任务完成，结构化终止 Agent 主循环。
 * Agent 检测到该工具调用后立即结束本轮迭代（finished=true）。
 */

export const finishSpec: ToolSpec = {
  name: 'finish',
  description:
    '标记任务完成并结束当前任务。message 为给用户的最终总结（必填）。这是任务结束的唯一结构化方式。',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: '给用户的最终总结' },
      status: { type: 'string', enum: ['success', 'partial', 'failed'], description: '完成状态（默认 success）' },
    },
    required: ['message'],
  },
  dangerLevel: 'low',
  skipSecurity: true,
}

export const finishHandler: ToolHandler = async (args) => {
  const message = argString(args.arguments, 'message')
  if (!message) {
    return {
      success: false,
      content: 'finish 缺少参数 message（最终总结）',
      restartRequested: false,
      errorCategory: 'permanent',
    }
  }
  const status = argString(args.arguments, 'status') ?? 'success'
  return {
    success: true,
    content: `任务结束（${status}）: ${message}`,
    restartRequested: false,
  }
}

/** Agent 判断工具调用是否为 finish（结构化终止） */
export function isFinishCall(name: string): boolean {
  return name === 'finish'
}
