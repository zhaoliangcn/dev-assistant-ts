import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString, argNumber } from '../common.js'
import { AppError } from '../../utils/error.js'
import { ReadCache } from '../cache.js'
import { buildSystemPrompt, subagentInstructions } from '../../prompt.js'
import { log } from '../../utils/logger.js'

/**
 * spawn_subagent：派生子代理执行子任务（对齐设计文档 8.4）。
 *
 * 约束：
 * - MAX_SUBAGENT_DEPTH = 3（超过抛 AppError.SubagentDepthLimit）
 * - 子代理共享 LlmClient / ToolRegistry / ApprovalManager（审批状态延续）
 * - 子代理有独立上下文（新 ContextManager），但共享同一 SessionStore 持久化
 * - 父代理只看到子代理的结构化总结（AgentResult.message）
 * - 子代理不继承 hooks 注入（避免 session-start 重复触发）
 * - spawn_subagent 自身不在子代理工具集中（防止无限递归注册）
 */

export const MAX_SUBAGENT_DEPTH = 3

export const spawnSubagentSpec: ToolSpec = {
  name: 'spawn_subagent',
  description:
    '派生一个子代理独立完成子任务（独立上下文、共享工具与审批）。父代理只收到子代理的结构化总结。task 需自包含（子代理看不到父对话）。深度上限 3。',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '子任务描述（自包含，子代理看不到父对话）' },
      maxIterations: { type: 'integer', description: '子代理最大迭代次数（默认 8）' },
    },
    required: ['task'],
  },
  dangerLevel: 'medium',
  approvalType: 'session',
  approvalScope: 'none',
}

export const spawnSubagentHandler: ToolHandler = async (args, ctx) => {
  const task = argString(args.arguments, 'task')
  if (!task) return fail('缺少参数 task（子任务描述）')

  const parent = ctx.agent
  if (!parent) return fail('spawn_subagent 只能在 Agent 运行上下文中使用')

  const childDepth = parent.depth + 1
  if (childDepth > MAX_SUBAGENT_DEPTH) {
    throw AppError.SubagentDepthLimit(childDepth)
  }

  const maxIterations = Math.min(20, Math.max(1, argNumber(args.arguments, 'maxIterations') ?? 8))

  log.info('派生子代理', { depth: childDepth, task: task.slice(0, 120) })

  // 延迟导入 Agent 避免循环依赖（registry → agent → tools/registry）
  const { Agent } = await import('../../agent/agent.js')
  const { subagentTools } = await import('../../app.js')

  const systemPrompt = buildSystemPrompt({
    workingDir: ctx.workingDir,
    platform: process.platform,
    sessionId: ctx.sessionId,
    approvalEnabled: !parent.approval.isDisabled(),
  }) +
    '\n\n' +
    subagentInstructions(task)

  const child = new Agent({
    llm: parent.llm,
    tools: subagentTools(parent.tools), // 移除 spawn_subagent 自身的工具集
    sessionStore: parent.sessionStore, // 共享持久化
    approval: parent.approval, // 复用审批状态
    workingDir: ctx.workingDir,
    maxIterations,
    systemPrompt,
    depth: childDepth,
  })
  child.setCache(new ReadCache()) // 独立缓存（子任务独立文件视图）

  const result = await child.run(task)

  const parts: string[] = [`子代理执行完成（depth=${childDepth}，${result.iterations} 轮，usage=${result.usage.totalTokens} tokens）`]
  if (result.finished && result.finishStatus && result.finishStatus !== 'restart') {
    parts.push(`结束状态: ${result.finishStatus}`)
  }
  parts.push(`--- 子代理总结 ---\n${result.message}`)
  if (!result.success) {
    parts.unshift(`⚠️ 子代理未成功完成`)
  }

  return {
    success: result.success,
    content: parts.join('\n'),
    restartRequested: false,
    errorCategory: result.success ? undefined : 'permanent',
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
