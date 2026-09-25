import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'
import { createTaskManager } from './task-manager.js'

/**
 * cancel_task：取消任务（对齐设计文档 6.6，high 危险级别）。
 * 语义：中断进行中循环 + 状态转 cancelled（不可恢复）。
 */

export const cancelTaskSpec: ToolSpec = {
  name: 'cancel_task',
  description:
    '取消一个任务（中断执行并标记为 cancelled，不可恢复）。不传 id 时取消当前会话最近的运行中任务。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '任务 id（可选；缺省取当前会话最近的运行中任务）' },
    },
  },
  dangerLevel: 'high',
  approvalType: 'session',
  approvalScope: 'none',
}

export const cancelTaskHandler: ToolHandler = async (args, ctx) => {
  const tm = createTaskManager(ctx.workingDir)
  try {
    let id = argString(args.arguments, 'id')
    if (!id) {
      const running = await tm.list({ status: 'running', sessionId: ctx.sessionId })
      if (running.length === 0) return fail('当前会话没有运行中的任务可取消')
      id = running[0]!.id
    }
    const task = await tm.cancel(id)
    if (!task) return fail(`未找到任务 ${id}`)
    if (task.status !== 'cancelled') {
      return ok(`任务 ${task.id} 当前状态为 ${task.status}，无需取消。`)
    }
    return ok(`任务已取消: ${task.id}（${task.description}）`)
  } catch (e) {
    return fail(`取消任务失败: ${e instanceof Error ? e.message : String(e)}`)
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
