import { createServer, type Server as HttpServer } from 'node:http'
import type { Express } from 'express'
import { buildRouter } from './router.js'
import { setupChatWs } from './ws/chat.js'
import type { App } from '../app.js'
import { log } from '../utils/logger.js'

/**
 * Web 服务启动（对齐设计文档 12 章 + CLI --web）。
 *
 * - HTTP：Express 路由（/api/*、/、/static/*）
 * - WS：/ws/chat 聊天协议（12.2）
 * - 调度引擎事件经 onTaskExecuted 广播到所有 WS 客户端
 */

export interface WebServerHandle {
  httpServer: HttpServer
  url: string
  close(): Promise<void>
}

export interface StartWebOptions {
  app: App
  host?: string
  port?: number
}

export async function startWeb(opts: StartWebOptions): Promise<WebServerHandle> {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 8080
  const expressApp: Express = buildRouter(opts.app)

  const httpServer = createServer(expressApp)

  // WS（/ws/chat）
  setupChatWs(httpServer, {
    getApp: () => ({
      run: (message: string) => opts.app.run(message),
      sessionId: opts.app.sessionId,
      setOnEvent: (cb) => opts.app.setOnEvent(cb),
    }),
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  })

  const address = httpServer.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const url = `http://${host}:${actualPort}`
  log.info('Web 服务已启动', { url })
  process.stdout.write(`Web: ${url}\n`)

  return {
    httpServer,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
        // 兜底：5 秒后强制关闭
        setTimeout(() => resolve(), 5_000).unref()
      }),
  }
}
