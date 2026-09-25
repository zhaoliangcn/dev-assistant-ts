import { setInterval, clearInterval } from 'node:timers'
import { nowIso } from '../persist/events.js'
import { log } from '../utils/logger.js'
import { TimeWheel } from './wheel.js'
import { ScheduledTaskStore } from './store.js'
import { INTERVAL_MS, type ScheduledTask, type TaskExecutor } from './types.js'

/**
 * 调度引擎（对齐设计文档 11 章 + Phase 5 计划）。
 *
 * - start()：加载持久化任务 → 全部排程进时间轮 → 每 1 秒 tick
 * - 到点任务：调用注入的 executor（记录 logs / lastStatus / runCount）
 *   - once 任务执行后 status → done
 *   - interval 任务按 everyMs 重排 nextAt
 * - stop()：清定时器与时间轮
 *
 * 漂移处理：排程 delay 基于 Date.now() 计算，不依赖 setInterval 精度
 * （设计文档 17 章风险缓解）。
 */

export interface SchedulerEngineOptions {
  /** 任务到点时的执行器（返回执行摘要） */
  executor: TaskExecutor
  /** 任务创建/更新时的回调（Web 层推事件用；可选） */
  onTaskChanged?: (task: ScheduledTask) => void
  /** 任务执行完成回调（可选） */
  onTaskExecuted?: (task: ScheduledTask, detail: string, ok: boolean) => void
}

export class SchedulerEngine {
  private wheel = new TimeWheel()
  private store: ScheduledTaskStore
  private timer: NodeJS.Timeout | null = null
  private opts: SchedulerEngineOptions
  private running = false
  private lastTickAt = 0

  constructor(workingDir: string, opts: SchedulerEngineOptions) {
    this.store = new ScheduledTaskStore(workingDir)
    this.opts = opts
  }

  get storePath(): string {
    return this.store.filePath
  }

  /** 任务存储（scheduler 工具族经此访问；engine 保持唯一写入口） */
  get tasks(): ScheduledTaskStore {
    return this.store
  }

  /** 启动：加载 + 排程 + 启动 tick 定时器（幂等） */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.lastTickAt = Date.now()

    const tasks = await this.store.list({ status: 'active' })
    for (const task of tasks) {
      this.scheduleTask(task)
    }
    log.info('调度器启动', { active: tasks.length, wheel: this.wheel.pendingCount() })

    this.timer = setInterval(() => {
      void this.doTick()
    }, INTERVAL_MS)
    // 不阻止进程退出
    this.timer.unref?.()
  }

  /** 停止：清定时器（任务持久化已在 create/update 时完成） */
  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.wheel.clear()
    log.debug('调度器停止')
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 创建并排程任务 */
  async createTask(name: string, prompt: string, schedule: ScheduledTask['schedule']): Promise<ScheduledTask> {
    const task = await this.store.create(name, prompt, schedule)
    this.scheduleTask(task)
    this.opts.onTaskChanged?.(task)
    return task
  }

  /** 取消任务（状态 canceled + 持久化；时间轮中残留到点时按 status 跳过） */
  async cancelTask(id: string): Promise<ScheduledTask | undefined> {
    const task = await this.store.get(id)
    if (!task) return undefined
    if (task.status === 'active') {
      await this.store.update(id, { status: 'canceled' })
      task.status = 'canceled'
      this.opts.onTaskChanged?.(task)
    }
    return task
  }

  /** 手动立即执行一次（调试/测试用；不影响排程状态） */
  async runNow(id: string): Promise<{ ok: boolean; detail: string }> {
    const task = await this.store.get(id)
    if (!task) return { ok: false, detail: '任务不存在' }
    return this.execute(task)
  }

  // -------------------------------------------------------------------

  /** 把任务排进时间轮（基于 schedule 计算 delay） */
  private scheduleTask(task: ScheduledTask): void {
    const delay = this.delayFor(task)
    if (delay === null) return // 已过期的一次性任务：直接补跑
    if (delay > 0) {
      this.wheel.schedule(task, delay)
    } else {
      // delay <= 0：立即到点
      this.wheel.schedule(task, INTERVAL_MS)
    }
  }

  /** 计算距触发延迟（毫秒）；null 表示已过期需立即补跑 */
  private delayFor(task: ScheduledTask): number | null {
    const dueAt = this.dueAtOf(task)
    if (!dueAt) return null
    return dueAt.getTime() - Date.now()
  }

  private dueAtOf(task: ScheduledTask): Date | null {
    if (task.schedule.type === 'once') {
      const d = new Date(task.schedule.at)
      return isNaN(d.getTime()) ? null : d
    }
    const d = new Date(task.schedule.nextAt)
    return isNaN(d.getTime()) ? null : d
  }

  /** 每秒步进：取到点任务并执行 */
  private async doTick(): Promise<void> {
    if (!this.running) return
    // 用 Date.now() 校准：定时器实际间隔与 INTERVAL_MS 的偏差由 delayFor 在下次排程时吸收
    this.lastTickAt = Date.now()

    const due = this.wheel.tick()
    for (const task of due) {
      if (task.status !== 'active') continue
      void this.executeAndReschedule(task)
    }
  }

  /** 执行任务并按类型收尾（once→done；interval→重排） */
  private async executeAndReschedule(task: ScheduledTask): Promise<void> {
    const { ok, detail } = await this.execute(task)

    if (task.schedule.type === 'once') {
      await this.store.update(task.id, { status: 'done' })
      task.status = 'done'
    } else {
      // interval：推进 nextAt（若已落后超过一个周期，快进到下一周期，避免堆积）
      const everyMs = task.schedule.everyMs
      let next = Date.now() + everyMs
      if (task.schedule.nextAt) {
        const base = new Date(task.schedule.nextAt).getTime()
        if (!isNaN(base) && base + everyMs > Date.now()) {
          next = base + everyMs
        }
      }
      const nextAt = new Date(next).toISOString()
      await this.store.update(task.id, { schedule: { ...task.schedule, nextAt } })
      task.schedule = { ...task.schedule, nextAt }
      if (this.running) this.wheel.schedule(task, next - Date.now())
    }
    this.opts.onTaskExecuted?.(task, detail, ok)
  }

  /** 执行 executor 并回写 lastRun/日志 */
  private async execute(task: ScheduledTask): Promise<{ ok: boolean; detail: string }> {
    const at = nowIso()
    log.info('调度任务触发', { id: task.id, name: task.name })
    let ok = true
    let detail = ''
    try {
      detail = await this.opts.executor(task)
    } catch (e) {
      ok = false
      detail = e instanceof Error ? e.message : String(e)
      log.error(`调度任务执行失败 ${task.id}: ${detail}`)
    }
    // 先更新内存态，再持久化绝对值（store 与 wheel 共享任务引用，避免双重自增）
    task.runCount += 1
    task.lastRunAt = at
    task.lastStatus = ok ? 'ok' : 'error'
    task.lastError = ok ? undefined : detail
    await this.store.update(task.id, {
      lastRunAt: at,
      lastStatus: ok ? 'ok' : 'error',
      lastError: ok ? undefined : detail,
      runCount: task.runCount,
    })
    await this.store.appendLog({
      at,
      taskId: task.id,
      taskName: task.name,
      status: ok ? 'ok' : 'error',
      detail: detail.slice(0, 500),
    })
    return { ok, detail }
  }

  // 测试辅助
  get _wheel(): TimeWheel {
    return this.wheel
  }
  get _lastTickAt(): number {
    return this.lastTickAt
  }
}
