import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { nowIso } from '../../persist/events.js'
import { log } from '../../utils/logger.js'

/**
 * 任务管理器（对齐设计文档 6.6 task 工具族）。
 *
 * 语义：每个 Agent 运行（run）在启动时登记为一个任务（running），
 * 完成/失败时更新状态；pause_task 暂停当前运行（abort 进行中循环，
 * 状态转 paused，上下文保留可 resume）；cancel_task 取消（abort + cancelled）。
 *
 * 存储：项目目录 `.dev-assistant-tasks.json`（跨进程可见历史；
 * 进程内运行态额外绑定 AbortController，重启后仅历史可查）。
 */

export type TaskStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface TaskRecord {
  id: string
  /** 任务描述（用户消息摘要） */
  description: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  /** 所属会话 id */
  sessionId: string
  /** 迭代轮次（更新时） */
  iterations: number
  /** 备注/错误信息 */
  note?: string
}

const TASKS_FILE = '.dev-assistant-tasks.json'
const MAX_RECORDS = 200

interface TasksFile {
  tasks: TaskRecord[]
}

export class TaskManager {
  private tasks: TaskRecord[] = []
  /** 进程内运行态：task id → abort controller（暂停/取消用） */
  private aborts = new Map<string, AbortController>()
  private file: string
  private loaded = false

  constructor(workingDir: string) {
    this.file = path.resolve(workingDir, TASKS_FILE)
  }

  get filePath(): string {
    return this.file
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text) as TasksFile
      if (parsed && Array.isArray(parsed.tasks)) {
        this.tasks = parsed.tasks.filter((t) => t && typeof t.id === 'string' && typeof t.status === 'string')
      }
    } catch {
      this.tasks = []
    }
  }

  /** 启动任务登记（Agent.run 开始时调用），返回 task id */
  async createTask(description: string, sessionId: string): Promise<string> {
    await this.ensureLoaded()
    const now = nowIso()
    const task: TaskRecord = {
      id: `task-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
      description: description.slice(0, 200),
      status: 'running',
      createdAt: now,
      updatedAt: now,
      sessionId,
      iterations: 0,
    }
    this.tasks.push(task)
    while (this.tasks.length > MAX_RECORDS) this.tasks.shift()
    await this.persist()
    log.debug('任务登记', { id: task.id, status: 'running' })
    return task.id
  }

  /** 绑定运行态 abort（暂停/取消时中断进行中的 Agent 循环） */
  bindAbort(taskId: string, controller: AbortController): void {
    this.aborts.set(taskId, controller)
  }

  unbindAbort(taskId: string): void {
    this.aborts.delete(taskId)
  }

  /** 更新任务状态 */
  async updateTask(
    taskId: string,
    patch: Partial<Pick<TaskRecord, 'status' | 'iterations' | 'note'>>,
  ): Promise<void> {
    await this.ensureLoaded()
    const task = this.tasks.find((t) => t.id === taskId)
    if (!task) return
    if (patch.status) task.status = patch.status
    if (patch.iterations !== undefined) task.iterations = patch.iterations
    if (patch.note !== undefined) task.note = patch.note
    task.updatedAt = nowIso()
    await this.persist()
  }

  /** 暂停：中断进行中循环 + 状态转 paused */
  async pause(taskId: string): Promise<TaskRecord | undefined> {
    await this.ensureLoaded()
    const task = this.tasks.find((t) => t.id === taskId)
    if (!task) return undefined
    if (task.status !== 'running') return task
    this.aborts.get(taskId)?.abort()
    this.aborts.delete(taskId)
    task.status = 'paused'
    task.updatedAt = nowIso()
    await this.persist()
    log.info('任务暂停', { id: taskId })
    return task
  }

  /** 恢复：状态转 running（实际重跑由上层触发新 run；此处仅状态迁移） */
  async resume(taskId: string): Promise<TaskRecord | undefined> {
    await this.ensureLoaded()
    const task = this.tasks.find((t) => t.id === taskId)
    if (!task) return undefined
    if (task.status !== 'paused') return task
    task.status = 'running'
    task.updatedAt = nowIso()
    await this.persist()
    log.info('任务恢复', { id: taskId })
    return task
  }

  /** 取消：中断 + 状态转 cancelled */
  async cancel(taskId: string): Promise<TaskRecord | undefined> {
    await this.ensureLoaded()
    const task = this.tasks.find((t) => t.id === taskId)
    if (!task) return undefined
    if (task.status === 'cancelled') return task
    this.aborts.get(taskId)?.abort()
    this.aborts.delete(taskId)
    task.status = 'cancelled'
    task.note = task.note ?? '用户取消'
    task.updatedAt = nowIso()
    await this.persist()
    log.warn('任务取消', { id: taskId })
    return task
  }

  /** 查询单个任务 */
  async get(taskId: string): Promise<TaskRecord | undefined> {
    await this.ensureLoaded()
    return this.tasks.find((t) => t.id === taskId)
  }

  /** 列出任务（可过滤状态/会话，最多 50 条，新在前） */
  async list(filter?: Partial<Pick<TaskRecord, 'status' | 'sessionId'>>): Promise<TaskRecord[]> {
    await this.ensureLoaded()
    return this.tasks
      .filter((t) => (filter?.status ? t.status === filter.status : true))
      .filter((t) => (filter?.sessionId ? t.sessionId === filter.sessionId : true))
      .slice(-50)
      .reverse()
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify({ tasks: this.tasks }, null, 2), 'utf8')
  }
}

/** 从 workingDir 构造（App/工具复用） */
export function createTaskManager(workingDir: string): TaskManager {
  return new TaskManager(workingDir)
}
