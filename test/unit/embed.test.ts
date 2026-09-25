import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createAssistantModule } from '../../src/embed/index.js'

/**
 * 嵌入模块测试（附录 B 契约）：
 * - mock LLM（OpenAI 兼容 SSE）驱动 Agent 完整循环
 * - 读写 vault 笔记（read_file/write_file 工具，approvalEnabled=false 自动审批）
 * - on('event') 事件订阅
 * - WS /ws/chat 聊天（同端口 HTTP + WS）
 * - setModels / switchModel / getStatus
 */

let dir: string
let mockPort: number
let mockServer: Awaited<ReturnType<typeof createServer>>
let requestLog: string[] = []
let nextReply: { kind: 'text' | 'toolCall'; text?: string; toolName?: string; args?: Record<string, unknown> } = {
  kind: 'text',
  text: '完成',
}

/** 构造 OpenAI 兼容 SSE 响应 */
function sseResponse(res: ServerResponse, payload: Record<string, unknown>, extra?: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: payload.delta ?? '' } }] })}\n\n`)
  if (extra) res.write(`data: ${JSON.stringify(extra)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-embed-'))
  // mock LLM：OpenAI 兼容 /chat/completions
  mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requestLog.push(body)
      const parsed = JSON.parse(body)
      const stream = Boolean(parsed.stream)
      // 工具结果回传后的第二轮（messages 末尾为 tool）→ 返回文本回答，避免 tool_call 死循环
      const lastMsg = parsed.messages?.[parsed.messages.length - 1]
      const wantToolCall = nextReply.kind === 'toolCall' && !(lastMsg && lastMsg.role === 'tool')

      if (wantToolCall) {
        const call = {
          id: 'call_test_1',
          type: 'function',
          function: { name: nextReply.toolName!, arguments: JSON.stringify(nextReply.args ?? {}) },
        }
        if (stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: call.id, function: { name: call.function.name, arguments: '' } }] } }] })}\n\n`,
          )
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] } }] })}\n\n`,
          )
          res.write('data: [DONE]\n\n')
          res.end()
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'mock',
              choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] } }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
          )
        }
        return
      }

      const text = nextReply.text ?? '完成'
      if (stream) {
        sseResponse(
          res,
          { delta: text.slice(0, Math.ceil(text.length / 2)) },
          { choices: [{ delta: { content: text.slice(Math.ceil(text.length / 2)) } }] },
        )
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'mock',
            choices: [{ message: { role: 'assistant', content: text } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        )
      }
    })
  })
  await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve))
  mockPort = (mockServer.address() as { port: number }).port
})

afterAll(async () => {
  mockServer?.close()
  await rm(dir, { recursive: true, force: true })
})

const MOCK_MODELS = () => [
  {
    name: 'mock',
    provider: 'openai' as const,
    apiUrl: `http://127.0.0.1:${mockPort}/v1`,
    apiKey: 'sk-mock',
    model: 'mock-1',
  },
]

describe('AssistantModule（附录 B 契约）', () => {
  it('start/run/on 事件订阅：读+写 vault 笔记（mock LLM 驱动工具调用）', async () => {
    const vault = path.join(dir, 'vault-1')
    await mkdir(vault, { recursive: true })
    await writeFile(path.join(vault, 'note.md'), '# 标题\n原有内容', 'utf8')

    const mod = createAssistantModule()
    const events: string[] = []
    const off = mod.on('event', (e) => events.push(e.kind as string))

    await mod.start({
      workingDir: vault,
      models: MOCK_MODELS(),
      approvalEnabled: false,
      schedulerEnabled: false,
    })
    try {
      expect(mod.getStatus().running).toBe(true)
      expect(mod.providerNames()).toEqual(['mock'])

      // 第 1 轮：LLM 指示 Agent 用 write_file 工具写入笔记
      nextReply = { kind: 'toolCall', toolName: 'write_file', args: { path: 'note.md', content: '# 标题\nAI 更新的内容' } }
      const result = await mod.run('把笔记更新为新内容')
      expect(result.success).toBe(true)
      expect(events).toContain('toolCall')
      expect(events).toContain('toolResult')

      const onDisk = await readFile(path.join(vault, 'note.md'), 'utf8')
      expect(onDisk).toBe('# 标题\nAI 更新的内容')

      // 第 2 轮：纯文本回答
      nextReply = { kind: 'text', text: '已经写好了' }
      const result2 = await mod.run('确认一下')
      expect(result2.success).toBe(true)
      expect(result2.message).toBe('已经写好了')
      expect(events).toContain('assistantStreamDelta')

      off()
    } finally {
      await mod.stop()
    }
    expect(mod.getStatus().running).toBe(false)
  })

  it('stop 后 run 抛错（契约边界）', async () => {
    const mod = createAssistantModule()
    await expect(mod.run('x')).rejects.toThrow('未启动')
  })

  it('disabledTools 裁剪：exec_command/run_hook 不出现在 LLM 工具 schema', async () => {
    const vault = path.join(dir, 'vault-prune')
    await mkdir(vault, { recursive: true })
    const mod = createAssistantModule()
    await mod.start({
      workingDir: vault,
      models: MOCK_MODELS(),
      schedulerEnabled: false,
      disabledTools: ['exec_command', 'run_hook'],
    })
    try {
      nextReply = { kind: 'text', text: 'ok' }
      await mod.run('hi')
      const lastRequest = JSON.parse(requestLog[requestLog.length - 1])
      const toolNames = (lastRequest.tools ?? []).map((t: { function: { name: string } }) => t.function.name)
      expect(toolNames).not.toContain('exec_command')
      expect(toolNames).not.toContain('run_hook')
      // 其余工具保留
      expect(toolNames).toContain('write_file')
      expect(toolNames).toContain('finish')
    } finally {
      await mod.stop()
    }
  })

  it('重复 start 抛错；setModels 热替换后 switchModel 生效', async () => {
    const vault = path.join(dir, 'vault-2')
    await mkdir(vault, { recursive: true })
    const mod = createAssistantModule()
    await mod.start({ workingDir: vault, models: MOCK_MODELS(), schedulerEnabled: false })
    try {
      await expect(mod.start({ workingDir: vault, models: MOCK_MODELS() })).rejects.toThrow('已在运行')

      await mod.setModels([
        { name: 'p1', provider: 'openai', apiUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'sk', model: 'm1' },
        { name: 'p2', provider: 'ollama', apiUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'sk', model: 'm2' },
      ])
      expect(mod.providerNames()).toEqual(['p1', 'p2'])
      expect(mod.switchModel('p2')).toBe(true)
      expect(mod.getStatus().activeProvider).toBe('p2')
      expect(mod.switchModel('nope')).toBe(false)
    } finally {
      await mod.stop()
    }
  })
})

describe('WS /ws/chat（嵌入模块同端口）', () => {
  it('连接 → session_ready → user_message 流式回包 → done', async () => {
    const vault = path.join(dir, 'vault-ws')
    await mkdir(vault, { recursive: true })
    const mod = createAssistantModule()
    await mod.start({
      workingDir: vault,
      models: MOCK_MODELS(),
      approvalEnabled: false,
      schedulerEnabled: false,
      port: 0, // 随机端口（status 里读真实端口）
    })
    try {
      nextReply = { kind: 'text', text: 'WS 你好' }
      const status = mod.getStatus()
      const port = status.port!
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`)
      const received: Array<Record<string, unknown>> = []
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WS 超时')), 10_000)
        ws.on('message', (data) => {
          const ev = JSON.parse(data.toString('utf8'))
          received.push(ev)
          if (ev.type === 'done') {
            clearTimeout(timer)
            resolve()
          }
        })
        ws.on('error', reject)
        ws.on('open', () => ws.send(JSON.stringify({ type: 'user_message', content: 'ping' })))
      })

      expect(received[0]).toMatchObject({ type: 'session_ready' })
      const deltas = received.filter((e) => e.type === 'assistant_stream_delta').map((e) => e.delta).join('')
      expect(deltas).toBe('WS 你好')
      const msg = received.find((e) => e.type === 'assistant_message')
      expect(msg).toMatchObject({ content: 'WS 你好' })
      expect(received[received.length - 1]).toMatchObject({ type: 'done' })
      ws.close()
    } finally {
      await mod.stop()
    }
  })
})

// requestLog 引用保留（断言请求确实到达 mock LLM 时可用）
void requestLog
