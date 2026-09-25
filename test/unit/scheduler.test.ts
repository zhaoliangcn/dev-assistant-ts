import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TimeWheel, type ScheduledTask, type TaskExecutor } from '../../src/scheduler/types.js'
import { TimeWheel as Wheel } from '../../src/scheduler/wheel.js'
import { SchedulerEngine } from '../../src/scheduler/engine.js'
import { ScheduledTaskStore } from '../../src/scheduler/store.js'

/**
 * Phase 5 调度器测试：TimeWheel 状态机 + SchedulerEngine 端到端（真实 1 秒 tick）。
 */

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-sched-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function mkTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    name: 'test',
    prompt: 'do it',
    schedule: { type: 'once', at: new Date().toISOString() },
    status: 'active',
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  }
}

describe('TimeWheel', () => {
  it('27 槽位（复刻 Rust 版）', () => {
    const wheel = new Wheel()
    expect(wheel.tickCount).toBe(27)
  })

  it('1 秒后到点任务在第 2 个 tick 返回（tick 语义：当前槽先弹出再前进）', () => {
    const wheel = new Wheel()
    const task = mkTask()
    wheel.schedule(task, 1_000) // 入桶 1（currentTick 0 + 1）
    expect(wheel.pendingCount()).toBe(1)
    expect(wheel.tick()).toHaveLength(0) // tick1 弹出桶 0（空），前进到桶 1
    const due = wheel.tick() // tick2 弹出桶 1
    expect(due).toHaveLength(1)
    expect(due[0]!.id).toBe(task.id)
    expect(wheel.pendingCount()).toBe(0)
  })

  it('3 秒后到点任务在第 4 个 tick 返回', () => {
    const wheel = new Wheel()
    const task = mkTask()
    wheel.schedule(task, 3_000) // 入桶 3
    expect(wheel.tick()).toHaveLength(0)
    expect(wheel.tick()).toHaveLength(0)
    expect(wheel.tick()).toHaveLength(0)
    const due = wheel.tick() // tick4 弹出桶 3
    expect(due.map((t) => t.id)).toEqual([task.id])
  })

  it('超过 27 秒的任务跨轮次后正确触发（rotation 标记）', () => {
    const wheel = new Wheel()
    const task = mkTask()
    wheel.schedule(task, 30_000) // targetTick=30 → 入桶 3，rotation=nextRotation+1
    // 第一圈 tick1..27：桶 3 在第 4 个 tick 弹出但 rotation 未达 → 不触发
    let dueCount = 0
    for (let i = 0; i < 27; i++) {
      dueCount += wheel.tick().length
    }
    expect(dueCount).toBe(0)
    // 第二圈：tick28 前进到 currentTick=0 → nextRotation++，此后桶 3 再次弹出时触发
    let triggered = false
    for (let i = 0; i < 10; i++) {
      if (wheel.tick().some((t) => t.id === task.id)) triggered = true
    }
    expect(triggered).toBe(true)
  })

  it('多任务同槽并存', () => {
    const wheel = new Wheel()
    const a = mkTask()
    const b = mkTask()
    wheel.schedule(a, 1_000)
    wheel.schedule(b, 1_000)
    expect(wheel.tick()).toHaveLength(0)
    const due = wheel.tick()
    expect(due.map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('clear 清空全部', () => {
    const wheel = new Wheel()
    wheel.schedule(mkTask(), 1_000)
    wheel.schedule(mkTask(), 5_000)
    wheel.clear()
    expect(wheel.pendingCount()).toBe(0)
  })
})

describe('SchedulerEngine', () => {
  it('once 任务触发一次后 done（真实 1 秒 tick）', async () => {
    const wd = path.join(dir, `e-${Math.random().toString(36).slice(2)}`)
    await (await import('node:fs/promises')).mkdir(wd, { recursive: true })
    const runs: string[] = []
    const engine = new SchedulerEngine(wd, { executor: async (t) => (runs.push(t.name), `ran ${t.name}`) })
    await engine.start()
    try {
      const task = await engine.createTask('once-test', 'prompt', {
        type: 'once',
        at: new Date(Date.now() + 1_200).toISOString(),
      })
      // 时间轮 1 秒粒度 + tick 相位偏移：最迟第 4 个 tick 触发
      await new Promise((r) => setTimeout(r, 5_000))
      const after = await engine.tasks.get(task.id)
      expect(after!.status).toBe('done')
      expect(after!.runCount).toBe(1)
      expect(after!.lastStatus).toBe('ok')
      expect(runs).toEqual(['once-test'])

      // 再等一个周期确认不再触发
      await new Promise((r) => setTimeout(r, 1_500))
      expect(runs).toEqual(['once-test'])
    } finally {
      engine.stop()
    }
  }, 20_000)

  it('interval 任务周期性触发（2 秒间隔，至少 2 次）', async () => {
    const wd = path.join(dir, `i-${Math.random().toString(36).slice(2)}`)
    await (await import('node:fs/promises')).mkdir(wd, { recursive: true })
    const engine = new SchedulerEngine(wd, { executor: async (t) => `ran ${t.name}` })
    await engine.start()
    try {
      await engine.createTask('interval-test', 'prompt', {
        type: 'interval',
        everyMs: 2_000,
        nextAt: new Date(Date.now() + 1_000).toISOString(),
      })
      await new Promise((r) => setTimeout(r, 5_500))
      const active = (await engine.tasks.list({ status: 'active' }))[0]!
      expect(active.runCount).toBeGreaterThanOrEqual(2)
      expect(active.schedule.type === 'interval' && active.schedule.nextAt).toBeTruthy()
    } finally {
      engine.stop()
    }
  }, 20_000)

  it('executor 失败记 lastError 且不影响后续触发', async () => {
    const wd = path.join(dir, `f-${Math.random().toString(36).slice(2)}`)
    await (await import('node:fs/promises')).mkdir(wd, { recursive: true })
    let failFirst = true
    const engine = new SchedulerEngine(wd, {
      executor: async () => {
        if (failFirst) {
          failFirst = false
          throw new Error('boom')
        }
        return 'ok'
      },
    })
    await engine.start()
    try {
      await engine.createTask('fail-test', 'prompt', {
        type: 'interval',
        everyMs: 1_500,
        nextAt: new Date(Date.now() + 300).toISOString(),
      })
      // 时间轮 1 秒粒度：两次触发之间约 2-3 个 tick，留足等待
      await new Promise((r) => setTimeout(r, 8_000))
      const active = (await engine.tasks.list({ status: 'active' }))[0]!
      expect(active.runCount).toBeGreaterThanOrEqual(2)
      // 第一次失败，之后成功（logsFor 最新在前）
      expect(active.lastStatus).toBe('ok')
      const logs = await engine.tasks.logsFor(active.id)
      expect(logs[0]!.status).toBe('ok')
      expect(logs[logs.length - 1]!.status).toBe('error')
    } finally {
      engine.stop()
    }
  }, 20_000)

  it('cancel 后不再触发', async () => {
    const wd = path.join(dir, `c-${Math.random().toString(36).slice(2)}`)
    await (await import('node:fs/promises')).mkdir(wd, { recursive: true })
    const runs: string[] = []
    const engine = new SchedulerEngine(wd, { executor: async (t) => (runs.push(t.name), 'ok') })
    await engine.start()
    try {
      const task = await engine.createTask('cancel-test', 'prompt', {
        type: 'interval',
        everyMs: 1_500,
        nextAt: new Date(Date.now() + 500).toISOString(),
      })
      await new Promise((r) => setTimeout(r, 700))
      await engine.cancelTask(task.id)
      await new Promise((r) => setTimeout(r, 2_000))
      expect(runs.length).toBeLessThanOrEqual(1)
      expect((await engine.tasks.get(task.id))!.status).toBe('canceled')
    } finally {
      engine.stop()
    }
  }, 10_000)

  it('重启后恢复 active 任务（持久化往返）', async () => {
    const wd = path.join(dir, `r-${Math.random().toString(36).slice(2)}`)
    await (await import('node:fs/promises')).mkdir(wd, { recursive: true })
    const e1 = new SchedulerEngine(wd, { executor: async () => 'ok' })
    await e1.start()
    const task = await e1.createTask('persist-test', 'prompt', {
      type: 'interval',
      everyMs: 60_000,
      nextAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    e1.stop()

    // 模拟重启：新 engine 加载持久化
    const e2 = new SchedulerEngine(wd, { executor: async () => 'ok' })
    await e2.start()
    try {
      const reloaded = await e2.tasks.get(task.id)
      expect(reloaded).toBeDefined()
      expect(reloaded!.status).toBe('active')
      expect(e2._wheel.pendingCount()).toBeGreaterThanOrEqual(1)
    } finally {
      e2.stop()
    }
  }, 10_000)
})

describe('ScheduledTaskStore', () => {
  it('日志追加 + 查询 + 环形上限', async () => {
    const wd = path.join(dir, `s-${Math.random().toString(36).slice(2)}`)
    await (await import('node:fs/promises')).mkdir(wd, { recursive: true })
    const store = new ScheduledTaskStore(wd)
    for (let i = 0; i < 5; i++) {
      await store.appendLog({
        at: new Date().toISOString(),
        taskId: 't1',
        taskName: '任务1',
        status: 'ok',
        detail: `log-${i}`,
      })
    }
    const logs = await store.logsFor('t1')
    expect(logs).toHaveLength(5)
    expect(logs[0]!.detail).toBe('log-4') // 新在前
    const other = await store.logsFor('t2')
    expect(other).toHaveLength(0)
  })

  it('损坏文件重置为空', async () => {
    const wd = path.join(dir, `corrupt-${Math.random().toString(36).slice(2)}`)
    await (await import('node:fs/promises')).mkdir(wd, { recursive: true })
    await (await import('node:fs/promises')).writeFile(
      path.join(wd, '.dev-assistant-scheduled.json'),
      '{broken',
      'utf8',
    )
    const store = new ScheduledTaskStore(wd)
    expect(await store.list()).toEqual([])
  })

  it('磁盘文件格式合法 JSON', async () => {
    const wd = path.join(dir, `fmt-${Math.random().toString(36).slice(2)}`)
    await (await import('node:fs/promises')).mkdir(wd, { recursive: true })
    const store = new ScheduledTaskStore(wd)
    await store.create('x', 'p', { type: 'once', at: new Date(Date.now() + 60_000).toISOString() })
    const raw = JSON.parse(await readFile(path.join(wd, '.dev-assistant-scheduled.json'), 'utf8'))
    expect(Array.isArray(raw.tasks)).toBe(true)
    expect(Array.isArray(raw.logs)).toBe(true)
  })
})

// 类型引用保持（executor 签名回归）
const _t: TaskExecutor = async () => 'ok'
void _t
