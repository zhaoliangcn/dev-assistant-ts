import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString, argNumber } from '../common.js'

/**
 * schedule_task：创建定时/延迟任务（对齐设计文档 6.8，high 危险级别）。
 *
 * type=once    一次性：at（ISO 时间）或 delayMinutes（延迟分钟数）
 * type=interval 周期：everyMinutes（间隔分钟数）
 *
 * 任务到点时，调度引擎以 prompt 驱动一次 Agent 运行（Web 层 executor 注入）。
 */

export const scheduleTaskSpec: ToolSpec = {
  name: 'schedule_task',
  description:
    '创建一个定时任务（到点时自动以 prompt 驱动一次 Agent 运行）。type=once 一次性（at 为 ISO 时间，或 delayMinutes 延迟分钟数）；type=interval 周期（everyMinutes 间隔）。任务持久化，进程重启后恢复。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '任务名（简短描述，如"每小时检查构建"）' },
      prompt: { type: 'string', description: '到点时执行的 Agent prompt（自包含）' },
      type: { type: 'string', enum: ['once', 'interval'], description: 'once=一次性，interval=周期' },
      at: { type: 'string', description: 'ISO 时间（once 模式，如 2026-09-24T10:00:00Z）' },
      delayMinutes: { type: 'number', description: '延迟分钟数（once 模式，与 at 二选一）' },
      everyMinutes: { type: 'number', description: '间隔分钟数（interval 模式，最小 1）' },
    },
    required: ['name', 'prompt', 'type'],
  },
  dangerLevel: 'high',
  approvalType: 'session',
  approvalScope: 'none',
}

export const scheduleTaskHandler: ToolHandler = async (args, ctx) => {
  const scheduler = ctx.scheduler
  if (!scheduler) return fail('调度器未启用（scheduler 未注入）')

  const name = argString(args.arguments, 'name')
  const prompt = argString(args.arguments, 'prompt')
  const type = argString(args.arguments, 'type')
  if (!name) return fail('缺少参数 name（任务名）')
  if (!prompt) return fail('缺少参数 prompt（执行内容）')
  if (type !== 'once' && type !== 'interval') {
    return fail('type 必须是 once 或 interval')
  }

  const now = Date.now()

  if (type === 'once') {
    const at = argString(args.arguments, 'at')
    const delayMinutes = argNumber(args.arguments, 'delayMinutes')
    let atMs: number | undefined
    if (at) {
      const d = new Date(at)
      if (isNaN(d.getTime())) return fail(`at 不是合法 ISO 时间: ${at}`)
      atMs = d.getTime()
    } else if (delayMinutes !== undefined) {
      if (delayMinutes <= 0) return fail('delayMinutes 必须大于 0')
      atMs = now + delayMinutes * 60_000
    } else {
      return fail('once 模式需要 at（ISO 时间）或 delayMinutes 之一')
    }
    if (atMs! <= now) return fail('触发时间必须晚于当前时间')

    const task = await scheduler.createTask(name, prompt, { type: 'once', at: new Date(atMs!).toISOString() })
    return {
      success: true,
      content: `定时任务已创建: ${task.name}（id=${task.id}）\n类型: 一次性，触发于 ${task.schedule.type === 'once' ? task.schedule.at : ''}`,
      restartRequested: false,
    }
  }

  // interval
  const everyMinutes = argNumber(args.arguments, 'everyMinutes')
  if (everyMinutes === undefined || everyMinutes < 1) {
    return fail('interval 模式需要 everyMinutes（间隔分钟数，最小 1）')
  }
  const everyMs = Math.round(everyMinutes * 60_000)
  const task = await scheduler.createTask(name, prompt, {
    type: 'interval',
    everyMs,
    nextAt: new Date(now + everyMs).toISOString(),
  })
  return {
    success: true,
    content: `周期任务已创建: ${task.name}（id=${task.id}）\n类型: 每 ${everyMinutes} 分钟，首次触发 ${task.schedule.type === 'interval' ? task.schedule.nextAt : ''}`,
    restartRequested: false,
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
