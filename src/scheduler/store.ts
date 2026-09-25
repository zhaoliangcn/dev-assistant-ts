import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { nowIso } from '../persist/events.js'
import type { ScheduledTask, TaskLogEntry, ScheduledTasksFile, TaskSchedule } from './types.js'

/**
 * 调度任务持久化（`.dev-assistant-scheduled.json`）。
 *
 * 跨进程重启恢复：engine.start() 时加载，所有 active 任务重新排程
 * （once 已过期的一次性任务直接补跑一次；interval 按 nextAt 重排）。
 * 日志环形保留 MAX_LOGS 条。
 */

const SCHEDULED_FILE = '.dev-assistant-scheduled.json'
const MAX_LOGS = 200
const MAX_TASKS = 100

export class ScheduledTaskStore {
  private tasks: ScheduledTask[] = []
  private logs: TaskLogEntry[] = []
  private file: string
  private loaded = false

  constructor(workingDir: string) {
    this.file = path.resolve(workingDir, SCHEDULED_FILE)
  }

  get filePath(): string {
    return this.file
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text) as ScheduledTasksFile
      if (parsed && Array.isArray(parsed.tasks)) {
        this.tasks = parsed.tasks.filter((t) => t && typeof t.id === 'string')
      }
      if (parsed && Array.isArray(parsed.logs)) {
        this.logs = parsed.logs
      }
    } catch {
      this.tasks = []
      this.logs = []
    }
  }

  /** 创建任务（立即持久化） */
  async create(name: string, prompt: string, schedule: TaskSchedule): Promise<ScheduledTask> {
    await this.ensureLoaded()
    const now = nowIso()
    const task: ScheduledTask = {
      id: `sched-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
      name: name.slice(0, 100),
      prompt,
      schedule,
      status: 'active',
      createdAt: now,
      runCount: 0,
    }
    this.tasks.push(task)
    while (this.tasks.length > MAX_TASKS) {
      // 淘汰最旧的已完成/已取消任务；全 active 时不删
      const idx = this.tasks.findIndex((t) => t.status !== 'active')
      if (idx === -1) break
      this.tasks.splice(idx, 1)
    }
    await this.persist()
    return task
  }

  async get(id: string): Promise<ScheduledTask | undefined> {
    await this.ensureLoaded()
    return this.tasks.find((t) => t.id === id)
  }

  async list(filter?: Partial<Pick<ScheduledTask, 'status'>>): Promise<ScheduledTask[]> {
    await this.ensureLoaded()
    return this.tasks
      .filter((t) => (filter?.status ? t.status === filter.status : true))
      .slice()
      .reverse()
  }

  /** 删除任务（active 或已终结均可） */
  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded()
    const before = this.tasks.length
    this.tasks = this.tasks.filter((t) => t.id !== id)
    if (this.tasks.length === before) return false
    await this.persist()
    return true
  }

  /** 更新任务状态（engine 执行后回写） */
  async update(id: string, patch: Partial<Pick<ScheduledTask, 'status' | 'lastRunAt' | 'lastStatus' | 'lastError' | 'runCount' | 'schedule'>>): Promise<void> {
    await this.ensureLoaded()
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return
    Object.assign(task, patch)
    await this.persist()
  }

  /** 追加执行日志 */
  async appendLog(entry: TaskLogEntry): Promise<void> {
    await this.ensureLoaded()
    this.logs.push(entry)
    while (this.logs.length > MAX_LOGS) this.logs.shift()
    await this.persist()
  }

  /** 任务日志（新在前，最多 limit 条） */
  async logsFor(taskId: string | undefined, limit = 50): Promise<TaskLogEntry[]> {
    await this.ensureLoaded()
    const filtered = taskId ? this.logs.filter((l) => l.taskId === taskId) : this.logs
    return filtered.slice(-limit).reverse()
  }

  private async persist(): Promise<void> {
    const data: ScheduledTasksFile = { tasks: this.tasks, logs: this.logs }
    await mkdir(path.dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(data, null, 2), 'utf8')
  }
}
