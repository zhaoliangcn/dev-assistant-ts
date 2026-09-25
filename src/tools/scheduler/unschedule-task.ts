import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'

/**
 * unschedule_task：取消调度（对齐设计文档 6.8，medium 危险级别）。
 */

export const unscheduleTaskSpec: ToolSpec = {
  name: 'unschedule_task',
  description:
    '取消一个已调度的任务（状态转 canceled，不再触发）。可传 id 精确取消；不传时列出当前 active 任务供选择。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '任务 id（缺省时列出 active 任务）' },
    },
  },
  dangerLevel: 'medium',
  approvalType: 'session',
  approvalScope: 'none',
}

export const unscheduleTaskHandler: ToolHandler = async (args, ctx) => {
  const scheduler = ctx.scheduler
  if (!scheduler) return fail('调度器未启用（scheduler 未注入）')

  const id = argString(args.arguments, 'id')
  if (!id) {
    const active = await scheduler.tasks.list({ status: 'active' })
    if (active.length === 0) return ok('当前没有 active 的调度任务。')
    const lines = active.map((t, i) => {
      const sched =
        t.schedule.type === 'once'
          ? `once @ ${t.schedule.at}`
          : `interval 每 ${Math.round(t.schedule.everyMs / 60_000)} 分钟`
      return `${i + 1}. ${t.name}（id=${t.id}，${sched}，已触发 ${t.runCount} 次）`
    })
    return ok(`当前 active 任务（传 id 取消）:\n${lines.join('\n')}`)
  }

  const task = await scheduler.cancelTask(id)
  if (!task) return fail(`未找到任务 ${id}`)
  if (task.status === 'canceled') {
    return ok(`任务 ${task.name}（id=${task.id}）已取消。`)
  }
  return ok(`任务 ${task.name}（id=${task.id}）状态为 ${task.status}，已无需取消。`)
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
