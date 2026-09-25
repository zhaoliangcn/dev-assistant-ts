import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'
import { createTaskManager } from './task-manager.js'

/**
 * resume_task：恢复任务（对齐设计文档 6.6，medium 危险级别）。
 * 语义：状态从 paused 转回 running；实际重跑由上层（REPL 新消息）触发，
 * 工具本身只做状态迁移（Agent 单线程模型，不在工具内再起循环）。
 */

export const resumeTaskSpec: ToolSpec = {
  name: 'resume_task',
  description:
    '恢复一个已暂停的任务（状态转回 running）。上下文保留，后续消息将在原上下文上继续。不传 id 时恢复当前会话最近的已暂停任务。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '任务 id（可选；缺省取当前会话最近的已暂停任务）' },
    },
  },
  dangerLevel: 'medium',
  approvalType: 'session',
  approvalScope: 'none',
}

export const resumeTaskHandler: ToolHandler = async (args, ctx) => {
  const tm = createTaskManager(ctx.workingDir)
  try {
    let id = argString(args.arguments, 'id')
    if (!id) {
      const paused = await tm.list({ status: 'paused', sessionId: ctx.sessionId })
      if (paused.length === 0) return fail('当前会话没有已暂停的任务可恢复')
      id = paused[0]!.id
    }
    const task = await tm.resume(id)
    if (!task) return fail(`未找到任务 ${id}`)
    if (task.status !== 'running') {
      return ok(`任务 ${task.id} 当前状态为 ${task.status}，无需恢复。`)
    }
    return ok(`任务已恢复: ${task.id}（${task.description}）\n后续消息将在此任务上下文继续。`)
  } catch (e) {
    return fail(`恢复任务失败: ${e instanceof Error ? e.message : String(e)}`)
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
