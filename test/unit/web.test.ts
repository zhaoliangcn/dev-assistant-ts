import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { agentEventToWsEvent, finalAssistantEvent } from '../../src/web/ws/events.js'
import type { AgentEvent } from '../../src/agent/agent.js'

/**
 * Phase 5 Web 层测试：
 * - WS 事件映射纯函数（events.ts）
 * - 内置聊天页 HTML
 * 完整 Express 路由集成依赖真实 App（LLM），由 E2E 冒烟覆盖（见 #7 CLI 冒烟）。
 */

let dir: string
const cleanups: Array<() => Promise<void>> = []

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-web-test-'))
})

afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()))
  await rm(dir, { recursive: true, force: true })
})

describe('agentEventToWsEvent（12.2 协议映射）', () => {
  it('assistantStreamDelta → assistant_stream_delta（isFinal=false）', () => {
    const ctx = { assistantSoFar: '' }
    const ev = agentEventToWsEvent({ kind: 'assistantStreamDelta', content: '你好' } as AgentEvent, ctx)
    expect(ev).toEqual({ type: 'assistant_stream_delta', delta: '你好', isFinal: false })
    expect(ctx.assistantSoFar).toBe('你好')
  })

  it('reasoningDelta → reasoning_delta', () => {
    const ev = agentEventToWsEvent({ kind: 'reasoningDelta', content: '思考中' } as AgentEvent, { assistantSoFar: '' })
    expect(ev).toEqual({ type: 'reasoning_delta', delta: '思考中', isFinal: false })
  })

  it('toolCall → tool_call（含工具名与参数）', () => {
    const ev = agentEventToWsEvent(
      {
        kind: 'toolCall',
        call: { id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
      } as AgentEvent,
      { assistantSoFar: '' },
    )
    expect(ev).toEqual({ type: 'tool_call', toolName: 'read_file', args: '{"path":"a.ts"}' })
  })

  it('toolResult → tool_result（success 透传）', () => {
    const ev = agentEventToWsEvent(
      {
        kind: 'toolResult',
        callId: '1',
        name: 'read_file',
        result: { success: true, content: 'file body', restartRequested: false },
      } as AgentEvent,
      { assistantSoFar: '' },
    )
    expect(ev).toEqual({ type: 'tool_result', toolName: 'read_file', success: true, content: 'file body' })
  })

  it('tokenUsage → token_usage（字段映射）', () => {
    const ev = agentEventToWsEvent(
      { kind: 'tokenUsage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } } as AgentEvent,
      { assistantSoFar: '' },
    )
    expect(ev).toEqual({ type: 'token_usage', promptTokens: 10, completionTokens: 5, totalTokens: 15 })
  })

  it('status/systemMessage → status', () => {
    expect(agentEventToWsEvent({ kind: 'status', content: '执行中' } as AgentEvent, { assistantSoFar: '' }))
      .toEqual({ type: 'status', content: '执行中' })
    expect(agentEventToWsEvent({ kind: 'systemMessage', content: '[hook] x' } as AgentEvent, { assistantSoFar: '' }))
      .toEqual({ type: 'status', content: '[hook] x' })
  })

  it('finalAssistantEvent：delta(isFinal) + assistant_message + done 序列', () => {
    const events = finalAssistantEvent('最终回答', '42')
    expect(events.map((e) => e.type)).toEqual(['assistant_stream_delta', 'assistant_message', 'done'])
    expect(events[1]).toMatchObject({ type: 'assistant_message', content: '最终回答', streaming: false })
    expect(events[2]).toMatchObject({ type: 'done', messageId: '42' })
  })

  it('空内容 finalAssistantEvent：不含 isFinal delta', () => {
    const events = finalAssistantEvent('', undefined)
    expect(events.map((e) => e.type)).toEqual(['assistant_message', 'done'])
  })
})

describe('WS chat 协议（setupChatWs 端到端，假 App）', () => {
  it('session_ready + user_message 流式回包 + done', async () => {
    const { createServer } = await import('node:http')
    const { setupChatWs } = await import('../../src/web/ws/chat.js')

    const server = createServer((_req, res) => {
      res.statusCode = 204
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    setupChatWs(server, {
      getApp: () => ({
        sessionId: 'sess-web-test',
        run: async (message: string) => ({ success: true, message: `echo: ${message}` }),
        setOnEvent: () => undefined,
      }),
    })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`)
    const received: Array<Record<string, unknown>> = []
    const finished = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS 超时')), 8_000)
      ws.on('message', (data) => {
        const ev = JSON.parse(data.toString('utf8'))
        received.push(ev)
        if (ev.type === 'done') {
          clearTimeout(timer)
          resolve()
        }
      })
      ws.on('error', reject)
    })

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'user_message', content: 'ping' }))
    })
    await finished

    expect(received[0]).toMatchObject({ type: 'session_ready', sessionId: 'sess-web-test' })
    const done = received[received.length - 1]
    expect(done).toMatchObject({ type: 'done' })
    const msg = received.find((e) => e.type === 'assistant_message')
    expect(msg).toMatchObject({ content: 'echo: ping', streaming: false })

    ws.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, 15_000)

  it('非法 JSON 回 error', async () => {
    const { createServer } = await import('node:http')
    const { setupChatWs } = await import('../../src/web/ws/chat.js')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    setupChatWs(server, {
      getApp: () => ({ sessionId: 'x', run: async () => ({ success: true, message: '' }), setOnEvent: () => undefined }),
    })
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`)
    const got = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('超时')), 5_000)
      ws.on('message', (data) => {
        const ev = JSON.parse(data.toString('utf8'))
        if (ev.type === 'error') {
          clearTimeout(timer)
          resolve(ev)
        }
      })
      ws.on('error', reject)
      ws.on('open', () => ws.send('not json'))
    })
    expect(got.content).toContain('JSON')
    ws.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, 10_000)
})

describe('内置聊天页', () => {
  /** 链式 res mock：type()/send() 均返回 this */
  function mockRes() {
    let body = ''
    const res: { type: (t: string) => typeof res; send: (s: string) => typeof res } = {
      type: () => res,
      send: (s: string) => {
        body = s
        return res
      },
    }
    return { res, getBody: () => body }
  }

  it('indexPageHandler 返回含 WS 客户端的 HTML', async () => {
    const { indexPageHandler } = await import('../../src/web/static.js')
    const handler = indexPageHandler(dir)
    const { res, getBody } = mockRes()
    handler({} as never, res as never)
    expect(getBody()).toContain('/ws/chat')
    expect(getBody()).toContain('user_message')
    expect(getBody().toLowerCase()).toContain('<!doctype html>')
  })

  it('静态目录存在时优先托管 index.html', async () => {
    const sub = path.join(dir, 'static-site')
    await mkdir(path.join(sub, '.dev-assistant-web'), { recursive: true })
    await writeFile(path.join(sub, '.dev-assistant-web', 'index.html'), '<html>custom</html>')
    const { indexPageHandler } = await import('../../src/web/static.js')
    const { res, getBody } = mockRes()
    indexPageHandler(sub)({} as never, res as never)
    expect(getBody()).toContain('custom')
  })
})

// dir 引用保留（避免未用变量告警）
void dir
