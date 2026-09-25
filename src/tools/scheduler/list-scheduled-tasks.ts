import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'

/**
 * list_scheduled_tasks：列出调度任务（对齐设计文档 6.8，low）。
 */

export const listScheduledTasksSpec: ToolSpec = {
  name: 'list_scheduled_tasks',
  description:
    '列出已调度的任务（含一次性与周期任务、执行次数、最近执行状态）。status 可过滤：active/done/canceled（默认全部）。',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['active', 'done', 'canceled'], description: '状态过滤（默认全部）' },
    },
  },
  dangerLevel: 'low',
}

export const listScheduledTasksHandler: ToolHandler = async (args, ctx) => {
  const scheduler = ctx.scheduler
  if (!scheduler) return fail('调度器未启用（scheduler 未注入）')

  const rawStatus = typeof args.arguments.status === 'string' ? args.arguments.status : undefined
  const status =
    rawStatus === 'active' || rawStatus === 'done' || rawStatus === 'canceled' ? rawStatus : undefined

  const tasks = await scheduler.tasks.list(status ? { status } : undefined)
  if (tasks.length === 0) return ok('当前没有任何调度任务。')

  const lines = tasks.map((t, i) => {
    const sched =
      t.schedule.type === 'once'
        ? `一次性 @ ${t.schedule.at}`
        : `每 ${Math.round(t.schedule.everyMs / 60_000)} 分钟（下次 ${t.schedule.nextAt}）`
    const last = t.lastRunAt ? `，最近执行 ${t.lastRunAt}（${t.lastStatus ?? '?'}${t.lastError ? `: ${t.lastError.slice(0, 60)}` : ''}）` : ''
    return `${i + 1}. ${t.name}（id=${t.id}，${sched}，状态 ${t.status}，已触发 ${t.runCount} 次${last}）`
  })
  return ok(`共 ${tasks.length} 个调度任务:\n${lines.join('\n')}`)
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
