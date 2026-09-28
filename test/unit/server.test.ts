import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { startWeb, type WebServerHandle } from '../../src/web/server.js'
import type { ServerEvent } from '../../src/web/ws/events.js'
import type { App } from '../../src/app.js'

/**
 * startWeb 集成测试：真实 HTTP 监听（port=0 临时端口）+ 真 ws 客户端。
 * App 用最小假实现（buildRouter 只读 workingDir/sessionId/llm/tools/memory/scheduler/approval），
 * 验证服务启动元信息、路由透传、/ws/chat 协议与 close() 生命周期。
 */

let dir: string
const handles: WebServerHandle[] = []

function fakeApp(): { app: App; run: ReturnType<typeof vi.fn>; setOnEvent: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (message: string) => ({ success: true, message: `echo:${message}` }))
  const setOnEvent = vi.fn()
  const app = {
    workingDir: dir,
    sessionId: 'sess-web-1',
    approval: { isDisabled: () => false },
    tools: { listNames: () => ['read_file', 'exec_command'] },
    memory: { size: 3 },
    scheduler: { isRunning: false },
    llm: { activeConfig: () => ({ name: '主模型' }), setActiveByName: () => undefined },
    run,
    setOnEvent,
  } as unknown as App
  return { app, run, setOnEvent }
}

async function start(): Promise<WebServerHandle> {
  const handle = await startWeb({ app: fakeApp().app, port: 0 })
  handles.push(handle)
  return handle
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve()
    ws.once('close', () => resolve())
    ws.close()
  })
}

// stdout 捕获（断言启动输出）
let writes: string[]
let originalWrite: typeof process.stdout.write
beforeEach(() => {
  writes = []
  originalWrite = process.stdout.write
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write
})
afterEach(() => {
  process.stdout.write = originalWrite
})

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-web-server-'))
})
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()))
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('startWeb 启动与生命周期', () => {
  it('port=0 分配临时端口，url 与实际监听一致，stdout 输出 Web 地址', async () => {
    const handle = await start()
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const addr = handle.httpServer.address() as AddressInfo
    expect(handle.url).toBe(`http://127.0.0.1:${addr.port}`)
    expect(handle.httpServer.listening).toBe(true)
    expect(writes.join('')).toBe(`Web: ${handle.url}\n`)
  })

  it('close() 后停止监听', async () => {
    const { app } = fakeApp()
    const handle = await startWeb({ app, port: 0 })
    handles.push(handle)
    expect(handle.httpServer.listening).toBe(true)
    await handle.close()
    expect(handle.httpServer.listening).toBe(false)
  })
})

describe('HTTP 路由透传（经 buildRouter）', () => {
  it('GET /api/status 返回快照字段与 CORS 头', async () => {
    const handle = await start()
    const res = await fetch(`${handle.url}/api/status`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      sessionId: 'sess-web-1',
      approvalEnabled: true,
      toolCount: 2,
      memoryCount: 3,
      schedulerRunning: false,
      activeProvider: '主模型',
    })
    expect(typeof body.uptimeSec).toBe('number')
  })

  it('OPTIONS 预检返回 204', async () => {
    const handle = await start()
    const res = await fetch(`${handle.url}/api/status`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
  })

  it('未知路由 404', async () => {
    const handle = await start()
    const res = await fetch(`${handle.url}/api/nope`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: '未知路由: GET /api/nope' })
  })
})

describe('/ws/chat 聊天协议', () => {
  async function connect(handle: WebServerHandle): Promise<{ ws: WebSocket; received: ServerEvent[] }> {
    const ws = new WebSocket(handle.url.replace('http://', 'ws://') + '/ws/chat')
    const received: ServerEvent[] = []
    ws.on('message', (data) => received.push(JSON.parse(String(data)) as ServerEvent))
    await new Promise<void>((resolve) => ws.once('open', resolve))
    return { ws, received }
  }

  it('连接即推 session_ready（当前会话 id）', async () => {
    const handle = await start()
    const { ws, received } = await connect(handle)
    await vi.waitFor(() => expect(received.some((e) => e.type === 'session_ready')).toBe(true))
    expect(received[0]).toEqual({ type: 'session_ready', sessionId: 'sess-web-1' })
    await closeWs(ws)
  })

  it('user_message：trim 后调用 app.run，推最终 assistant_message + done(messageId)', async () => {
    const { app, run, setOnEvent } = fakeApp()
    const handle = await startWeb({ app, port: 0 })
    handles.push(handle)
    const { ws, received } = await connect(handle)
    await vi.waitFor(() => expect(received.some((e) => e.type === 'session_ready')).toBe(true))

    ws.send(JSON.stringify({ type: 'user_message', content: '  你好  ' }))
    await vi.waitFor(() => {
      expect(received.some((e) => e.type === 'assistant_message')).toBe(true)
      expect(received.some((e) => e.type === 'done')).toBe(true)
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('你好')
    expect(received.find((e) => e.type === 'assistant_message')).toEqual({
      type: 'assistant_message',
      content: 'echo:你好',
      streaming: false,
    })
    // content 非空 → 前置 isFinal 的空 stream_delta；done 携带递增 messageId
    expect(received.some((e) => e.type === 'assistant_stream_delta' && e.isFinal === true)).toBe(true)
    expect(received.find((e) => e.type === 'done')).toEqual({ type: 'done', messageId: '1' })
    // startWeb 已把事件回调接入 app
    expect(setOnEvent).toHaveBeenCalled()
    await closeWs(ws)
  })

  it('user_message 内容为空 → error 事件', async () => {
    const handle = await start()
    const { ws, received } = await connect(handle)
    await vi.waitFor(() => expect(received.some((e) => e.type === 'session_ready')).toBe(true))
    ws.send(JSON.stringify({ type: 'user_message', content: '   ' }))
    await vi.waitFor(() => expect(received.some((e) => e.type === 'error')).toBe(true))
    expect(received.find((e) => e.type === 'error')).toEqual({ type: 'error', content: 'user_message 内容为空' })
    await closeWs(ws)
  })

  it('非法 JSON → error 事件', async () => {
    const handle = await start()
    const { ws, received } = await connect(handle)
    await vi.waitFor(() => expect(received.some((e) => e.type === 'session_ready')).toBe(true))
    ws.send('这不是 JSON')
    await vi.waitFor(() => expect(received.some((e) => e.type === 'error')).toBe(true))
    expect(received.find((e) => e.type === 'error')).toEqual({ type: 'error', content: 'WS 消息不是合法 JSON' })
    await closeWs(ws)
  })

  it('cancel 消息被忽略（不产生新事件）', async () => {
    const handle = await start()
    const { ws, received } = await connect(handle)
    await vi.waitFor(() => expect(received.some((e) => e.type === 'session_ready')).toBe(true))
    const before = received.length
    ws.send(JSON.stringify({ type: 'cancel' }))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(received.length).toBe(before)
    await closeWs(ws)
  })

  it('app.run 抛错 → error + done 事件', async () => {
    const { app, run } = fakeApp()
    run.mockRejectedValueOnce(new Error('LLM 炸了'))
    const handle = await startWeb({ app, port: 0 })
    handles.push(handle)
    const { ws, received } = await connect(handle)
    await vi.waitFor(() => expect(received.some((e) => e.type === 'session_ready')).toBe(true))
    ws.send(JSON.stringify({ type: 'user_message', content: '触发失败' }))
    await vi.waitFor(() => {
      expect(received.some((e) => e.type === 'error')).toBe(true)
      expect(received.some((e) => e.type === 'done')).toBe(true)
    })
    expect(received.find((e) => e.type === 'error')).toEqual({ type: 'error', content: 'LLM 炸了' })
    expect(received.find((e) => e.type === 'done')).toEqual({ type: 'done', messageId: '1' })
    await closeWs(ws)
  })
})
