import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'

/**
 * restart：请求重启 Agent 会话。
 * handler 本身不做事，仅返回 restartRequested=true，由 Agent 主循环处理
 * （清空上下文、重新构建 system prompt、保留会话持久化）。
 */

export const restartSpec: ToolSpec = {
  name: 'restart',
  description:
    '请求重启 Agent 会话：清空当前对话上下文并以新系统提示词重新开始（会话持久化保留）。仅在上下文严重污染或需要重置状态时使用。reason 说明重启原因。',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: '重启原因' },
    },
    required: ['reason'],
  },
  dangerLevel: 'medium',
  skipSecurity: true,
}

export const restartHandler: ToolHandler = async (args) => {
  const reason = argString(args.arguments, 'reason') ?? '（未说明原因）'
  return {
    success: true,
    content: `收到重启请求: ${reason}`,
    restartRequested: true,
  }
}
