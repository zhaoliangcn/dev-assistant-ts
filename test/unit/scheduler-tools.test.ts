import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SchedulerEngine } from '../../src/scheduler/engine.js'
import type { TaskExecutor } from '../../src/scheduler/types.js'
import { ReadCache } from '../../src/tools/cache.js'
import { scheduleTaskHandler } from '../../src/tools/scheduler/schedule-task.js'
import { listScheduledTasksHandler } from '../../src/tools/scheduler/list-scheduled-tasks.js'
import { unscheduleTaskHandler } from '../../src/tools/scheduler/unschedule-task.js'
import { getScheduledTaskLogsHandler } from '../../src/tools/scheduler/get-scheduled-task-logs.js'
import type { ToolContext, ToolHandler, ToolResult } from '../../src/tools/registry.js'

/**
 * scheduler 工具族测试：直接调用 handler（registry/安全层在 registry.test.ts 已覆盖）。
 * 使用真实 SchedulerEngine + 临时目录；不调用 start()，因此不会产生任何定时器。
 */

const okExecutor: TaskExecutor = async () => 'mock 执行'
const cache = new ReadCache()
const dirs: string[] = []
let envSeq = 0

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

async function makeEnv(executor: TaskExecutor = okExecutor): Promise<{ engine: SchedulerEngine }> {
  const dir = await mkdtemp(path.join(tmpdir(), `dev-assistant-sched-${envSeq++}-`))
  dirs.push(dir)
  return { engine: new SchedulerEngine(dir, { executor }) }
}

function ctx(engine: SchedulerEngine): ToolContext {
  return { workingDir: '/virtual/workdir', cache, scheduler: engine }
}

async function run(handler: ToolHandler, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return handler({ arguments: args }, context)
}

function futureIso(msAhead = 3_600_000): string {
  return new Date(Date.now() + msAhead).toISOString()
}

// ---------------------------------------------------------------------------

describe('schedule_task', () => {
  let engine: SchedulerEngine
  beforeAll(async () => {
    ;({ engine } = await makeEnv())
  })
  afterAll(() => engine.stop())

  it('调度器未注入时失败', async () => {
    const r = await run(scheduleTaskHandler, { name: 'x', prompt: 'p', type: 'once', delayMinutes: 1 }, { workingDir: '/w', cache })
    expect(r.success).toBe(false)
    expect(r.content).toBe('调度器未启用（scheduler 未注入）')
    expect(r.errorCategory).toBe('permanent')
  })

  it('缺少 name', async () => {
    const r = await run(scheduleTaskHandler, { prompt: 'p', type: 'once', delayMinutes: 1 }, ctx(engine))
    expect(r.content).toBe('缺少参数 name（任务名）')
  })

  it('缺少 prompt', async () => {
    const r = await run(scheduleTaskHandler, { name: 'x', type: 'once', delayMinutes: 1 }, ctx(engine))
    expect(r.content).toBe('缺少参数 prompt（执行内容）')
  })

  it('type 非法', async () => {
    const r = await run(scheduleTaskHandler, { name: 'x', prompt: 'p', type: 'daily' }, ctx(engine))
    expect(r.content).toBe('type 必须是 once 或 interval')
  })

  it('once：at 不是合法 ISO 时间', async () => {
    const r = await run(scheduleTaskHandler, { name: 'x', prompt: 'p', type: 'once', at: 'not-a-date' }, ctx(engine))
    expect(r.content).toBe('at 不是合法 ISO 时间: not-a-date')
  })

  it('once：delayMinutes 必须大于 0', async () => {
    const r = await run(scheduleTaskHandler, { name: 'x', prompt: 'p', type: 'once', delayMinutes: 0 }, ctx(engine))
    expect(r.content).toBe('delayMinutes 必须大于 0')
  })

  it('once：at 与 delayMinutes 都缺省', async () => {
    const r = await run(scheduleTaskHandler, { name: 'x', prompt: 'p', type: 'once' }, ctx(engine))
    expect(r.content).toBe('once 模式需要 at（ISO 时间）或 delayMinutes 之一')
  })

  it('once：触发时间必须晚于当前时间', async () => {
    const r = await run(scheduleTaskHandler, { name: 'x', prompt: 'p', type: 'once', at: futureIso(-60_000) }, ctx(engine))
    expect(r.content).toBe('触发时间必须晚于当前时间')
  })

  it('once：at 成功创建并持久化', async () => {
    const at = futureIso()
    const r = await run(scheduleTaskHandler, { name: '每日报表', prompt: '生成日报', type: 'once', at }, ctx(engine))
    expect(r.success).toBe(true)
    expect(r.content).toContain('定时任务已创建: 每日报表（id=sched-')
    expect(r.content).toContain(`类型: 一次性，触发于 ${at}`)
    // 落盘验证
    const raw = JSON.parse(await readFile(engine.storePath, 'utf8')) as { tasks: Array<{ name: string; status: string; schedule: { type: string; at: string } }> }
    const saved = raw.tasks.find((t) => t.name === '每日报表')
    expect(saved?.status).toBe('active')
    expect(saved?.schedule).toEqual({ type: 'once', at })
  })

  it('once：delayMinutes 换算触发时间', async () => {
    const before = Date.now()
    const r = await run(scheduleTaskHandler, { name: '延迟任务', prompt: 'p', type: 'once', delayMinutes: 5 }, ctx(engine))
    expect(r.success).toBe(true)
    const tasks = await engine.tasks.list()
    const task = tasks.find((t) => t.name === '延迟任务')
    expect(task).toBeDefined()
    const atMs = new Date(task?.schedule.type === 'once' ? task.schedule.at : '').getTime()
    expect(atMs).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1_000)
    expect(atMs).toBeLessThanOrEqual(Date.now() + 5 * 60_000)
  })

  it('interval：成功创建周期任务', async () => {
    const r = await run(scheduleTaskHandler, { name: '巡检', prompt: 'p', type: 'interval', everyMinutes: 90 }, ctx(engine))
    expect(r.success).toBe(true)
    expect(r.content).toContain('周期任务已创建: 巡检（id=sched-')
    expect(r.content).toContain('类型: 每 90 分钟，首次触发 ')
    const task = (await engine.tasks.list()).find((t) => t.name === '巡检')
    expect(task?.schedule).toMatchObject({ type: 'interval', everyMs: 90 * 60_000 })
  })

  it('interval：缺 everyMinutes', async () => {
    const r = await run(scheduleTaskHandler, { name: 'x', prompt: 'p', type: 'interval' }, ctx(engine))
    expect(r.content).toBe('interval 模式需要 everyMinutes（间隔分钟数，最小 1）')
  })

  it('interval：everyMinutes 小于 1', async () => {
    const r = await run(scheduleTaskHandler, { name: 'x', prompt: 'p', type: 'interval', everyMinutes: 0.5 }, ctx(engine))
    expect(r.content).toBe('interval 模式需要 everyMinutes（间隔分钟数，最小 1）')
  })
})

// ---------------------------------------------------------------------------

describe('list_scheduled_tasks', () => {
  let engine: SchedulerEngine
  beforeAll(async () => {
    ;({ engine } = await makeEnv())
  })
  afterAll(() => engine.stop())

  it('调度器未注入时失败', async () => {
    const r = await run(listScheduledTasksHandler, {}, { workingDir: '/w', cache })
    expect(r.success).toBe(false)
    expect(r.content).toBe('调度器未启用（scheduler 未注入）')
  })

  it('空列表', async () => {
    const r = await run(listScheduledTasksHandler, {}, ctx(engine))
    expect(r.success).toBe(true)
    expect(r.content).toBe('当前没有任何调度任务。')
  })

  it('once 与 interval 渲染格式', async () => {
    const at = futureIso()
    await engine.createTask('每日报表', 'p', { type: 'once', at })
    await engine.createTask('巡检', 'p', { type: 'interval', everyMs: 90 * 60_000, nextAt: futureIso(5 * 60_000) })
    const r = await run(listScheduledTasksHandler, {}, ctx(engine))
    expect(r.content).toContain(`一次性 @ ${at}`)
    expect(r.content).toMatch(/每 90 分钟（下次 \d{4}-\d{2}-\d{2}T/)
    expect(r.content).toContain('，状态 active，已触发 0 次')
  })

  it('status 过滤 active/canceled', async () => {
    await engine.createTask('过滤A', 'p', { type: 'once', at: futureIso() })
    const b = await engine.createTask('过滤B', 'p', { type: 'once', at: futureIso() })
    await engine.cancelTask(b.id)
    const canceled = await run(listScheduledTasksHandler, { status: 'canceled' }, ctx(engine))
    expect(canceled.content).toContain('过滤B')
    expect(canceled.content).not.toContain('过滤A')
    const active = await run(listScheduledTasksHandler, { status: 'active' }, ctx(engine))
    expect(active.content).toContain('过滤A')
    expect(active.content).not.toContain('过滤B')
  })

  it('非法 status 被忽略（返回全部）', async () => {
    const r = await run(listScheduledTasksHandler, { status: 'bogus' }, ctx(engine))
    expect(r.content).toContain('过滤A')
    expect(r.content).toContain('过滤B')
  })

  it('最近执行状态与 lastError 截断 60 字符', async () => {
    const t = await engine.createTask('带日志任务', 'p', { type: 'once', at: futureIso() })
    await engine.tasks.update(t.id, {
      lastRunAt: '2026-09-28T00:00:00.000Z',
      lastStatus: 'error',
      lastError: 'e'.repeat(70),
      runCount: 5,
    })
    const r = await run(listScheduledTasksHandler, {}, ctx(engine))
    expect(r.content).toContain('带日志任务')
    expect(r.content).toContain(`已触发 5 次，最近执行 2026-09-28T00:00:00.000Z（error: ${'e'.repeat(60)}）`)
  })

  it('成功执行后显示（ok）', async () => {
    const t = await engine.createTask('跑过的任务', 'p', { type: 'once', at: futureIso() })
    const res = await engine.runNow(t.id)
    expect(res.ok).toBe(true)
    const r = await run(listScheduledTasksHandler, {}, ctx(engine))
    expect(r.content).toMatch(/跑过的任务.*已触发 1 次，最近执行 .+（ok）/)
  })
})

// ---------------------------------------------------------------------------

describe('unschedule_task', () => {
  let engine: SchedulerEngine
  beforeAll(async () => {
    ;({ engine } = await makeEnv())
  })
  afterAll(() => engine.stop())

  it('调度器未注入时失败', async () => {
    const r = await run(unscheduleTaskHandler, {}, { workingDir: '/w', cache })
    expect(r.success).toBe(false)
    expect(r.content).toBe('调度器未启用（scheduler 未注入）')
  })

  it('无 id 且无 active 任务', async () => {
    const r = await run(unscheduleTaskHandler, {}, ctx(engine))
    expect(r.success).toBe(true)
    expect(r.content).toBe('当前没有 active 的调度任务。')
  })

  it('无 id 时列出 active 任务', async () => {
    const at = futureIso()
    await engine.createTask('早报', 'p', { type: 'once', at })
    await engine.createTask('巡检', 'p', { type: 'interval', everyMs: 30 * 60_000, nextAt: futureIso() })
    const r = await run(unscheduleTaskHandler, {}, ctx(engine))
    expect(r.content).toContain('当前 active 任务（传 id 取消）:')
    expect(r.content).toContain(`once @ ${at}`)
    expect(r.content).toContain('interval 每 30 分钟')
  })

  it('传 id 取消成功', async () => {
    const t = await engine.createTask('夜间构建', 'p', { type: 'once', at: futureIso() })
    const r = await run(unscheduleTaskHandler, { id: t.id }, ctx(engine))
    expect(r.success).toBe(true)
    expect(r.content).toBe(`任务 夜间构建（id=${t.id}）已取消。`)
    const after = await engine.tasks.get(t.id)
    expect(after?.status).toBe('canceled')
  })

  it('已取消的任务再次取消：幂等提示已取消', async () => {
    const t = await engine.createTask('重复取消', 'p', { type: 'once', at: futureIso() })
    await engine.cancelTask(t.id)
    const r = await run(unscheduleTaskHandler, { id: t.id }, ctx(engine))
    expect(r.content).toBe(`任务 重复取消（id=${t.id}）已取消。`)
  })

  it('done 状态：已无需取消', async () => {
    const t = await engine.createTask('已完成', 'p', { type: 'once', at: futureIso() })
    await engine.tasks.update(t.id, { status: 'done' })
    const r = await run(unscheduleTaskHandler, { id: t.id }, ctx(engine))
    expect(r.content).toBe(`任务 已完成（id=${t.id}）状态为 done，已无需取消。`)
  })

  it('id 不存在', async () => {
    const r = await run(unscheduleTaskHandler, { id: 'ghost' }, ctx(engine))
    expect(r.success).toBe(false)
    expect(r.content).toBe('未找到任务 ghost')
    expect(r.errorCategory).toBe('permanent')
  })
})

// ---------------------------------------------------------------------------

describe('get_scheduled_task_logs', () => {
  let engine: SchedulerEngine
  beforeAll(async () => {
    ;({ engine } = await makeEnv())
  })
  afterAll(() => engine.stop())

  it('调度器未注入时失败', async () => {
    const r = await run(getScheduledTaskLogsHandler, {}, { workingDir: '/w', cache })
    expect(r.success).toBe(false)
    expect(r.content).toBe('调度器未启用（scheduler 未注入）')
  })

  it('id 不存在', async () => {
    const r = await run(getScheduledTaskLogsHandler, { id: 'ghost' }, ctx(engine))
    expect(r.content).toBe('未找到任务 ghost')
  })

  it('id 存在但无执行记录', async () => {
    const t = await engine.createTask('无记录任务', 'p', { type: 'once', at: futureIso() })
    const r = await run(getScheduledTaskLogsHandler, { id: t.id }, ctx(engine))
    expect(r.success).toBe(true)
    expect(r.content).toBe('任务 无记录任务 还没有执行记录。')
  })

  it('单任务日志：ok 标记与 detail', async () => {
    const t = await engine.createTask('报告', 'p', { type: 'once', at: futureIso() })
    await engine.runNow(t.id) // executor 返回 'mock 执行'
    const r = await run(getScheduledTaskLogsHandler, { id: t.id }, ctx(engine))
    expect(r.content).toContain('报告 最近 1 条执行记录:')
    expect(r.content).toMatch(/^- .+ ✓ mock 执行$/m)
  })

  it('error 日志显示 ✗ 与 detail', async () => {
    const t = await engine.createTask('错误任务', 'p', { type: 'once', at: futureIso() })
    await engine.tasks.appendLog({ at: '2026-09-28T01:00:00.000Z', taskId: t.id, taskName: '错误任务', status: 'error', detail: 'boom 失败' })
    const r = await run(getScheduledTaskLogsHandler, { id: t.id }, ctx(engine))
    expect(r.content).toContain('- 2026-09-28T01:00:00.000Z ✗ boom 失败')
  })

  it('detail 为空时回退默认文案', async () => {
    const t = await engine.createTask('空详情任务', 'p', { type: 'once', at: futureIso() })
    await engine.tasks.appendLog({ at: '2026-09-28T02:00:00.000Z', taskId: t.id, taskName: '空详情任务', status: 'ok', detail: '' })
    const okR = await run(getScheduledTaskLogsHandler, { id: t.id }, ctx(engine))
    expect(okR.content).toContain('- 2026-09-28T02:00:00.000Z ✓ 执行成功')
    await engine.tasks.appendLog({ at: '2026-09-28T03:00:00.000Z', taskId: t.id, taskName: '空详情任务', status: 'error', detail: '' })
    const errR = await run(getScheduledTaskLogsHandler, { id: t.id }, ctx(engine))
    expect(errR.content).toContain('- 2026-09-28T03:00:00.000Z ✗ 执行失败')
  })

  it('不传 id：全部任务日志带任务名前缀', async () => {
    const r = await run(getScheduledTaskLogsHandler, {}, ctx(engine))
    expect(r.content).toContain('全部任务 最近 ')
    expect(r.content).toContain('条执行记录:')
    expect(r.content).toContain(' [报告]')
    expect(r.content).toContain(' [错误任务]')
  })

  it('limit 钳制：取最近的 N 条（新在前）', async () => {
    const t = await engine.createTask('限额任务', 'p', { type: 'once', at: futureIso() })
    for (let i = 1; i <= 3; i++) {
      await engine.tasks.appendLog({ at: `2026-09-28T04:0${i}:00.000Z`, taskId: t.id, taskName: '限额任务', status: 'ok', detail: `第${i}次` })
    }
    const all = await run(getScheduledTaskLogsHandler, { id: t.id }, ctx(engine))
    expect(all.content).toContain('限额任务 最近 3 条执行记录:')
    expect(all.content.indexOf('第3次')).toBeLessThan(all.content.indexOf('第2次'))

    const limited = await run(getScheduledTaskLogsHandler, { id: t.id, limit: 2 }, ctx(engine))
    expect(limited.content).toContain('最近 2 条执行记录:')
    expect(limited.content).toContain('第3次')
    expect(limited.content).not.toContain('第1次')

    const minOne = await run(getScheduledTaskLogsHandler, { id: t.id, limit: 0 }, ctx(engine))
    expect(minOne.content).toContain('最近 1 条执行记录:')
    expect(minOne.content).toContain('第3次')
  })
})
