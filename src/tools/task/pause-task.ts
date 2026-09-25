import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'
import { createTaskManager } from './task-manager.js'

/**
 * pause_task：暂停任务（对齐设计文档 6.6，medium 危险级别）。
 * 语义：中断进行中的 Agent 循环（abort），状态转 paused；
 * 上下文与持久化保留，可 resume_task 恢复。
 */

export const pauseTaskSpec: ToolSpec = {
  name: 'pause_task',
  description:
    '暂停一个运行中的任务（中断其进行中的执行，保留上下文）。暂停后可用 resume_task 恢复。不传 id 时暂停当前会话最近的运行中任务。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '任务 id（可选；缺省取当前会话最近的运行中任务）' },
    },
  },
  dangerLevel: 'medium',
  approvalType: 'session',
  approvalScope: 'none',
}

export const pauseTaskHandler: ToolHandler = async (args, ctx) => {
  const tm = createTaskManager(ctx.workingDir)
  try {
    let id = argString(args.arguments, 'id')
    if (!id) {
      const running = await tm.list({ status: 'running', sessionId: ctx.sessionId })
      if (running.length === 0) return fail('当前会话没有运行中的任务可暂停')
      id = running[0]!.id
    }
    const task = await tm.pause(id)
    if (!task) return fail(`未找到任务 ${id}`)
    if (task.status !== 'paused') {
      return ok(`任务 ${task.id} 当前状态为 ${task.status}，无需暂停。`)
    }
    return ok(`任务已暂停: ${task.id}（${task.description}）\n可用 resume_task 恢复。`)
  } catch (e) {
    return fail(`暂停任务失败: ${e instanceof Error ? e.message : String(e)}`)
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
