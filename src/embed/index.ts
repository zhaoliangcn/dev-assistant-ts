import { createServer, type Server as HttpServer } from 'node:http'
import { App } from '../app.js'
import { buildRouter } from '../web/router.js'
import { setupChatWs, type ChatAppHandle } from '../web/ws/chat.js'
import type { AgentEvent, AgentResult } from '../agent/agent.js'
import type { ProviderConfig } from '../llm/models.js'
import { AppError } from '../utils/error.js'
import { log } from '../utils/logger.js'

export type { AgentEvent, AgentResult, ProviderConfig }

/**
 * 嵌入模块（对齐设计文档附录 B：AssistantModule）。
 *
 * 供宿主应用（devworkbench 主进程）以编程方式启动/停止 AI 助手：
 * - run(message)：驱动 Agent 完整循环（工具调用、调度、技能、记忆）
 * - on('event')：订阅 Agent 事件流（宿主 IPC 转发渲染进程用）
 * - start({ port })：可选 HTTP + /ws/chat（复用 Web 层路由与 WS 协议）
 * - setModels / switchModel：模型配置运行时热替换（宿主设置页保存后调用）
 *
 * 事件分发：模块独占 App.setOnEvent 全局槽位作为唯一分发器；
 * WS 层（chat.ts）的 setOnEvent 经 wsHandle 代理到模块的 WS sink，不互相覆盖。
 *
 * 嵌入安全默认：审批在无终端场景下自动通过（宿主应把 workingDir 限定在受控目录，
 * 文件工具内置路径越界防护，exec_command 等 critical 工具由宿主按场景决定是否裁剪）。
 */

export interface AssistantStartOptions {
  /** 工作目录（嵌入场景通常为宿主的 Vault/项目目录） */
  workingDir: string
  /** 模型配置（至少一个 provider） */
  models: ProviderConfig[]
  /** 提供时启动 HTTP 服务（Express 路由 + /ws/chat） */
  port?: number
  host?: string
  /** 启用调度引擎 tick（默认 true） */
  schedulerEnabled?: boolean
  /** 审批模式（嵌入默认 false：自动通过，宿主负责工作区隔离） */
  approvalEnabled?: boolean
  /** 按名称裁剪工具（嵌入场景建议至少禁 exec_command/run_hook，关闭任意命令执行面） */
  disabledTools?: string[]
  maxIterations?: number
  maxTokens?: number
}

export interface AssistantStatus {
  running: boolean
  port: number | null
  url: string | null
  sessionId: string | null
  providerNames: string[]
  activeProvider: string | null
}

export type AssistantEventCallback = (e: AgentEvent) => void

export interface AssistantModule {
  /** 启动（幂等：已运行时抛错） */
  start(options: AssistantStartOptions): Promise<void>
  /** 停止并释放资源（幂等） */
  stop(): Promise<void>
  getStatus(): AssistantStatus
  /** 驱动一次 Agent 运行（未启动时抛错） */
  run(message: string): Promise<AgentResult>
  /** 订阅 Agent 事件；返回取消订阅函数 */
  on(event: 'event', callback: AssistantEventCallback): () => void
  /** 已配置 provider 名称列表 */
  providerNames(): string[]
  /** 热切换活跃 provider（按名称） */
  switchModel(name: string): boolean
  /** 运行时整体替换模型配置（设置页保存后调用） */
  setModels(models: ProviderConfig[]): Promise<void>
}

export function createAssistantModule(): AssistantModule {
  let app: App | null = null
  let httpServer: HttpServer | null = null
  let url: string | null = null
  const subscribers = new Set<AssistantEventCallback>()
  /** WS 层（chat.ts）绑定的事件 sink（每用户消息覆盖，单连接语义） */
  let wsSink: ((e: AgentEvent) => void) | null = null

  function dispatch(e: AgentEvent): void {
    wsSink?.(e)
    for (const cb of subscribers) {
      try {
        cb(e)
      } catch (err) {
        log.warn('事件订阅回调出错', { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  function requireApp(): App {
    if (!app) throw AppError.Internal('助手未启动（先调用 start）')
    return app
  }

  /** 传给 setupChatWs 的 App 代理：setOnEvent 重定向到模块 WS sink，避免覆盖全局分发器 */
  const wsHandle: ChatAppHandle = {
    run: (message: string) => {
      const a = requireApp()
      return a.run(message).then((r) => ({ success: r.success, message: r.message }))
    },
    get sessionId() {
      return requireApp().sessionId
    },
    setOnEvent: (cb) => {
      wsSink = (e) => cb(e as never)
    },
  }

  return {
    async start(options) {
      if (app) throw AppError.Internal('助手已在运行（先 stop 再 start）')

      app = await App.create({
        workingDir: options.workingDir,
        models: options.models,
        maxIterations: options.maxIterations,
        maxTokens: options.maxTokens,
        approvalEnabled: options.approvalEnabled ?? false,
        disabledTools: options.disabledTools,
        schedulerEnabled: options.schedulerEnabled ?? true,
      })
      // 模块独占全局事件槽位（WS 层经 wsHandle 代理，不竞争）
      app.setOnEvent((e) => dispatch(e as AgentEvent))
      log.info('嵌入助手启动', { workingDir: options.workingDir, providers: options.models.length })

      if (options.port !== undefined) {
        const host = options.host ?? '127.0.0.1'
        httpServer = createServer(buildRouter(app))
        setupChatWs(httpServer, { getApp: () => wsHandle })
        await new Promise<void>((resolve, reject) => {
          httpServer!.once('error', reject)
          httpServer!.listen(options.port, host, () => {
            httpServer!.removeListener('error', reject)
            resolve()
          })
        })
        // 取 OS 分配的真实端口（支持 port=0 随机端口）
        const addr = httpServer.address()
        const actualPort = typeof addr === 'object' && addr ? addr.port : options.port
        url = `http://${host}:${actualPort}`
        log.info('嵌入助手 Web 已启动', { url })
      }
    },

    async stop() {
      const a = app
      const server = httpServer
      app = null
      httpServer = null
      url = null
      wsSink = null
      subscribers.clear()
      if (!a && !server) return
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          setTimeout(() => resolve(), 5_000).unref()
        })
      }
      if (a) await a.close()
      log.info('嵌入助手已停止')
    },

    getStatus(): AssistantStatus {
      const a = app
      return {
        running: a !== null,
        port: url ? Number(new URL(url).port) : null,
        url,
        sessionId: a?.sessionId ?? null,
        providerNames: a ? a.llm.providerNames() : [],
        activeProvider: a?.llm.activeConfig()?.name ?? null,
      }
    },

    async run(message: string) {
      return requireApp().run(message)
    },

    on(_event, callback) {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    },

    providerNames() {
      return app ? app.llm.providerNames() : []
    },

    switchModel(name) {
      return app ? app.llm.setActiveByName(name) : false
    },

    async setModels(models) {
      const a = requireApp()
      await a.replaceLlm(models)
      log.info('嵌入助手模型已热替换', { providers: models.length })
    },
  }
}
