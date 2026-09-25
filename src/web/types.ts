import type { App } from '../app.js'
import type { SchedulerEngine } from '../scheduler/engine.js'

/**
 * Web 层类型（对齐设计文档 12 章）。
 */

/** Web 服务状态（Express 路由 + WS 处理器共享） */
export interface WebState {
  app: App
  host: string
  port: number
}

/** 调度引擎执行事件回调（任务触发/完成时推 WS） */
export type SchedulerNotifier = (payload: Record<string, unknown>) => void

/** 启动 Web 服务 */
export interface StartWebOptions {
  app: App
  host?: string
  port?: number
}

export { type App, type SchedulerEngine }
