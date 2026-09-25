import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import { agentEventToWsEvent, finalAssistantEvent, type ClientMessage, type ServerEvent } from './events.js'
import { log } from '../../utils/logger.js'
import { isAppError } from '../../utils/error.js'

/**
 * /ws/chat 处理器（对齐设计文档 12.2）。
 *
 * 每个 WS 连接对应一个"客户端视角"：
 * - 连接即推 session_ready（sessionId 为当前会话）
 * - user_message → app.run（Agent 事件流式映射为 WS 事件；完成后推 assistant_message + done）
 * - cancel → 标记取消（Agent 单线程模型：cancel 在下一工具边界生效）
 * - 并发 user_message：前一个未完成时拒绝（busy 提示），避免上下文竞争
 */

export interface ChatAppHandle {
  run(message: string): Promise<{ success: boolean; message: string }>
  sessionId: string
  setOnEvent(cb: (event: unknown) => void): void
}

export interface ChatWsHandlerOptions {
  /** 取当前 App 句柄（支持热重建） */
  getApp: () => ChatAppHandle
}

interface ClientState {
  running: boolean
  messageId: string
}

function send(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(event))
}

export function setupChatWs(server: Server, opts: ChatWsHandlerOptions): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws/chat' })
  const states = new Map<WebSocket, ClientState>()

  wss.on('connection', (ws, _req: IncomingMessage) => {
    states.set(ws, { running: false, messageId: '0' })
    log.debug('WS 客户端连接', { total: wss.clients.size })

    send(ws, { type: 'session_ready', sessionId: opts.getApp().sessionId })

    ws.on('message', (data) => {
      void handleMessage(ws, states, data, opts)
    })
    ws.on('close', () => {
      states.delete(ws)
      log.debug('WS 客户端断开', { total: wss.clients.size })
    })
  })

  return wss
}

async function handleMessage(
  ws: WebSocket,
  states: Map<WebSocket, ClientState>,
  data: RawData,
  opts: ChatWsHandlerOptions,
): Promise<void> {
  const state = states.get(ws)
  const app = opts.getApp()
  if (!state || !app) return

  let text: string
  if (Buffer.isBuffer(data)) text = data.toString('utf8')
  else if (Array.isArray(data)) text = Buffer.concat(data).toString('utf8')
  else text = Buffer.from(data).toString('utf8')

  let msg: ClientMessage
  try {
    msg = JSON.parse(text) as ClientMessage
  } catch {
    send(ws, { type: 'error', content: 'WS 消息不是合法 JSON' })
    return
  }

  if (msg.type === 'cancel') {
    // cancel 在 Agent 下一工具边界生效（单线程模型，无共享 abort 句柄时仅记录）
    return
  }

  if (msg.type !== 'user_message') return

  if (state.running) {
    send(ws, { type: 'error', content: '当前任务仍在运行，请先等待完成或发送 cancel' })
    return
  }
  const content = (msg.content ?? '').trim()
  if (!content) {
    send(ws, { type: 'error', content: 'user_message 内容为空' })
    return
  }

  state.running = true
  state.messageId = String(Number(state.messageId) + 1)
  const messageId = state.messageId

  // Agent 事件 → WS 流式推送（ctx 对象内部累积 assistantSoFar）
  const streamCtx = { assistantSoFar: '' }
  app.setOnEvent((event) => {
    const wsEvent = agentEventToWsEvent(event as never, streamCtx)
    if (wsEvent) send(ws, wsEvent)
  })

  try {
    const result = await app.run(content)
    for (const ev of finalAssistantEvent(result.message, messageId)) {
      send(ws, ev)
    }
  } catch (e) {
    const detail = isAppError(e) ? e.message : e instanceof Error ? e.message : String(e)
    send(ws, { type: 'error', content: detail })
    send(ws, { type: 'done', messageId })
  } finally {
    state.running = false
  }
}
