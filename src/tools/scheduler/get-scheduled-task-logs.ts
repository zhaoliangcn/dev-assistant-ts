import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString, argNumber } from '../common.js'

/**
 * get_scheduled_task_logs：获取任务执行日志（对齐设计文档 6.8，low）。
 */

export const getScheduledTaskLogsSpec: ToolSpec = {
  name: 'get_scheduled_task_logs',
  description:
    '获取调度任务的执行日志（每次触发的时间与结果）。传 id 看单个任务；不传看全部（最近 limit 条）。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '任务 id（缺省看全部）' },
      limit: { type: 'integer', description: '返回条数（默认 20，上限 100）' },
    },
  },
  dangerLevel: 'low',
}

export const getScheduledTaskLogsHandler: ToolHandler = async (args, ctx) => {
  const scheduler = ctx.scheduler
  if (!scheduler) return fail('调度器未启用（scheduler 未注入）')

  const id = argString(args.arguments, 'id')
  const limit = Math.min(100, Math.max(1, argNumber(args.arguments, 'limit') ?? 20))

  if (id) {
    const task = await scheduler.tasks.get(id)
    if (!task) return fail(`未找到任务 ${id}`)
    const logs = await scheduler.tasks.logsFor(id, limit)
    if (logs.length === 0) return ok(`任务 ${task.name} 还没有执行记录。`)
    return renderLogs(task.name, logs)
  }

  const logs = await scheduler.tasks.logsFor(undefined, limit)
  if (logs.length === 0) return ok('还没有任何调度执行记录。')
  return renderLogs('全部任务', logs)
}

function renderLogs(scope: string, logs: Array<{ at: string; taskName: string; status: string; detail: string; taskId: string }>): { success: true; content: string; restartRequested: false } {
  const lines = logs.map((l) => {
    const mark = l.status === 'ok' ? '✓' : '✗'
    const name = scope === '全部任务' ? ` [${l.taskName}]` : ''
    return `- ${l.at} ${mark}${name} ${l.detail || (l.status === 'ok' ? '执行成功' : '执行失败')}`
  })
  return {
    success: true,
    content: `${scope} 最近 ${logs.length} 条执行记录:\n${lines.join('\n')}`,
    restartRequested: false,
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
