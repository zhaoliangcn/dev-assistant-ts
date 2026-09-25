/**
 * 调度器类型定义（对齐设计文档 11 章 + 6.8 调度工具族）。
 *
 * 任务模型：
 * - once     一次性任务：at（ISO 时间）触发后 status → done
 * - interval 周期任务：everyMs 间隔，触发后重排 nextAt
 *
 * 执行语义：到点时 engine 调用 onExecute(task)，由上层注入执行器
 * （Web 层注入"以 prompt 驱动 Agent 运行"；CLI/测试注入自定义逻辑）。
 * 执行器失败不影响调度器本身（记入 logs，下次照旧触发）。
 */

export const TICK_COUNT = 27 // 复刻 Rust 版时间轮槽位数
export const INTERVAL_MS = 1_000 // 时间轮步进：1 秒

export type TaskSchedule =
  | { type: 'once'; at: string }
  | { type: 'interval'; everyMs: number; nextAt: string }

export type TaskStatus = 'active' | 'done' | 'canceled'

export interface ScheduledTask {
  id: string
  name: string
  /** 触发时执行的 Agent prompt */
  prompt: string
  schedule: TaskSchedule
  status: TaskStatus
  createdAt: string
  lastRunAt?: string
  lastStatus?: 'ok' | 'error'
  lastError?: string
  runCount: number
  /** 时间轮旋转标记（engine 内部用，持久化） */
  rotation?: number
}

export interface TaskLogEntry {
  at: string
  taskId: string
  taskName: string
  status: 'ok' | 'error'
  detail: string
}

export interface ScheduledTasksFile {
  tasks: ScheduledTask[]
  logs: TaskLogEntry[]
}

/** 执行器签名：engine 在任务到点时调用 */
export type TaskExecutor = (task: ScheduledTask) => Promise<string>
