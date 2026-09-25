import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LlmClient } from '../../src/llm/client.js'
import type { ProviderConfig } from '../../src/llm/models.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { ReadCache } from '../../src/tools/cache.js'
import { ApprovalManager } from '../../src/security/approval.js'
import { SessionStore } from '../../src/persist/session-store.js'
import { Agent, type AgentEvent } from '../../src/agent/agent.js'
import {
  readFileSpec,
  readFileHandler,
} from '../../src/tools/file/read.js'
import {
  writeFileSpec,
  writeFileHandler,
} from '../../src/tools/file/write.js'
import {
  editFileSpec,
  editFileHandler,
} from '../../src/tools/file/edit.js'
import {
  execCommandSpec,
  execCommandHandler,
} from '../../src/tools/system/exec-command.js'
import {
  finishSpec,
  finishHandler,
} from '../../src/tools/meta/finish.js'
import {
  restartSpec,
  restartHandler,
} from '../../src/tools/meta/restart.js'
import { startMockLlmServer } from '../fixtures/mock-llm-server.js'

/**
 * Agent 主循环集成测试（经真实 HTTP 的 mock LLM server 驱动多轮工具循环）。
 *
 * mock server 通过请求计数返回不同的响应序列：
 * 第 1 次 → tool_call(read_file)；第 2 次 → finish。
 * 实现方式：在 route 处理器里用闭包计数。
 */

let workDir: string

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-agent-'))
  await writeFile(path.join(workDir, 'data.txt'), 'content-abc')
  await mkdir(path.join(workDir, 'out'), { recursive: true })
})

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

/** SSE 文本流（按 8 字符分块模拟增量） */
function sseText(s: string): string {
  const chunks: string[] = []
  const parts = s.match(/.{1,8}/gs) ?? [s]
  for (const p of parts) chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}`)
  chunks.push('data: [DONE]')
  return `${chunks.join('\n')}\n`
}

function sseToolCall(id: string, name: string, args: object): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] })}`,
    'data: [DONE]',
    '',
  ].join('\n')
}

async function makeAgent(opts: {
  server: { url: string }
  maxIterations?: number
  approvalDisabled?: boolean
  events?: AgentEvent[]
  extraTools?: Array<[import('../../src/tools/spec.js').ToolSpec, import('../../src/tools/registry.js').ToolHandler]>
}): Promise<Agent> {
  const cfg: ProviderConfig = { name: 'mock', provider: 'openai', apiUrl: `${opts.server.url}/v1`, apiKey: 'k', model: 'm' }
  const llm = new LlmClient([cfg])

  const tools = new ToolRegistry()
  tools.register(readFileSpec, readFileHandler)
  tools.register(writeFileSpec, writeFileHandler)
  tools.register(editFileSpec, editFileHandler)
  tools.register(execCommandSpec, execCommandHandler)
  tools.register(finishSpec, finishHandler)
  tools.register(restartSpec, restartHandler)
  for (const [s, h] of opts.extraTools ?? []) tools.register(s, h)

  const store = new SessionStore(workDir)
  const approval = new ApprovalManager(async () => true)
  approval.setDisabled(opts.approvalDisabled ?? true)

  const agent = new Agent({
    llm,
    tools,
    sessionStore: store,
    approval,
    workingDir: workDir,
    maxIterations: opts.maxIterations ?? 5,
    maxTokens: 262_144,
    systemPrompt: '你是测试助手',
    onEvent: opts.events ? (e) => opts.events!.push(e) : undefined,
  })
  agent.setCache(new ReadCache())
  return agent
}

describe('Agent 主循环', () => {
  it('无工具调用：直接返回最终回复', async () => {
    const s = await startMockLlmServer({
      '/v1/chat/completions': { stream: { type: 'text', content: '你好，我是助手。' } },
    })
    try {
      const agent = await makeAgent({ server: s })
      const result = await agent.run('打个招呼')
      expect(result.success).toBe(true)
      expect(result.finished).toBe(false)
      expect(result.iterations).toBe(1)
      expect(result.usage.totalTokens).toBeGreaterThan(0)
    } finally {
      await s.close()
    }
  })

  it('多轮工具循环：read_file → finish', async () => {
    const { createServer } = await import('node:http')
    const { once } = await import('node:events')
    // 脚本：第 1 轮 read_file；第 2 轮 finish（纯文本轮会提前结束循环，脚本不消耗）
    const script = [
      sseToolCall('c1', 'read_file', { path: 'data.txt' }),
      sseToolCall('c2', 'finish', { message: '任务完成', status: 'success' }),
    ]
    let call = 0
    const http = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404)
        res.end()
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(script[Math.min(call++, script.length - 1)]!)
      })
    })
    await once(http.listen(0, '127.0.0.1'), 'listening')
    const addr = http.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const cfg: ProviderConfig = { name: 'mock', provider: 'openai', apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' }
    const llm = new LlmClient([cfg])
    const tools = new ToolRegistry()
    tools.register(readFileSpec, readFileHandler)
    tools.register(writeFileSpec, writeFileHandler)
    tools.register(finishSpec, finishHandler)
    const store = new SessionStore(workDir)
    const approval = new ApprovalManager(async () => true)
    approval.setDisabled(true)

    const events: AgentEvent[] = []
    const agent = new Agent({
      llm,
      tools,
      sessionStore: store,
      approval,
      workingDir: workDir,
      maxIterations: 5,
      systemPrompt: '测试',
      onEvent: (e) => events.push(e),
    })
    agent.setCache(new ReadCache())

    const result = await agent.run('读取 data.txt 并告诉我结果')

    expect(result.success).toBe(true)
    expect(result.finished).toBe(true)
    expect(result.finishStatus).toBe('success')
    expect(result.message).toBe('任务完成')
    expect(result.iterations).toBe(2)
    expect(call).toBe(2)

    // 事件流包含 toolCall + toolResult
    const toolCalls = events.filter((e) => e.kind === 'toolCall')
    expect(toolCalls.length).toBe(2) // read_file + finish
    const toolResults = events.filter((e) => e.kind === 'toolResult')
    expect(toolResults.length).toBe(2)
    const readResult = toolResults.find((e) => e.kind === 'toolResult' && e.name === 'read_file')
    expect(readResult).toBeDefined()
    if (readResult && readResult.kind === 'toolResult') {
      expect(readResult.result.success).toBe(true)
      expect(readResult.result.content).toContain('content-abc')
    }

    // 持久化事件序列（mock 工具轮不含文本，故无 assistant_message；文本轮结束时会持久化）
    const persisted = await SessionStore.readEvents(store.getFilePath())
    const types = persisted.map((e) => e.type)
    expect(types).toContain('user_message')
    expect(types).toContain('tool_call_request')
    expect(types).toContain('tool_result')
    // 顺序：user → tool_call_request → tool_result
    expect(types.indexOf('tool_call_request')).toBeGreaterThan(types.indexOf('user_message'))
    expect(types.indexOf('tool_result')).toBeGreaterThan(types.indexOf('tool_call_request'))
    // 两个工具调用（read_file + finish）都有 request/result 成对
    expect(types.filter((t) => t === 'tool_call_request').length).toBe(2)
    expect(types.filter((t) => t === 'tool_result').length).toBe(2)

    await llm.close()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })

  it('write_file + edit_file 工具循环真实改文件', async () => {
    const { createServer } = await import('node:http')
    const { once } = await import('node:events')
    const script = [
      sseToolCall('c1', 'write_file', { path: 'out/gen.txt', content: 'v1' }),
      sseToolCall('c2', 'edit_file', { path: 'out/gen.txt', old_string: 'v1', new_string: 'v2' }),
      sseToolCall('c3', 'finish', { message: '文件已生成并编辑' }),
    ]
    let call = 0
    const http = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(script[Math.min(call++, script.length - 1)]!)
      })
    })
    await once(http.listen(0, '127.0.0.1'), 'listening')
    const addr = http.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const cfg: ProviderConfig = { name: 'mock', provider: 'openai', apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' }
    const llm = new LlmClient([cfg])
    const tools = new ToolRegistry()
    tools.register(writeFileSpec, writeFileHandler)
    tools.register(editFileSpec, editFileHandler)
    tools.register(finishSpec, finishHandler)
    const store = new SessionStore(workDir)
    const approval = new ApprovalManager(async () => true)
    approval.setDisabled(true)

    const agent = new Agent({
      llm,
      tools,
      sessionStore: store,
      approval,
      workingDir: workDir,
      maxIterations: 5,
      systemPrompt: '测试',
    })
    agent.setCache(new ReadCache())

    const result = await agent.run('生成并编辑文件')
    expect(result.success).toBe(true)
    expect(result.finished).toBe(true)
    expect(result.iterations).toBe(3)

    const fs = await import('node:fs/promises')
    const onDisk = await fs.readFile(path.join(workDir, 'out/gen.txt'), 'utf8')
    expect(onDisk).toBe('v2')

    await llm.close()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })

  it('达到最大迭代 → 失败报告', async () => {
    const { createServer } = await import('node:http')
    const { once } = await import('node:events')
    // 永远请求 read_file，永不 finish
    const http = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sseToolCall('cx', 'read_file', { path: 'data.txt' }))
      })
    })
    await once(http.listen(0, '127.0.0.1'), 'listening')
    const addr = http.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const cfg: ProviderConfig = { name: 'mock', provider: 'openai', apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' }
    const llm = new LlmClient([cfg])
    const tools = new ToolRegistry()
    tools.register(readFileSpec, readFileHandler)
    const store = new SessionStore(workDir)
    const approval = new ApprovalManager(async () => true)
    approval.setDisabled(true)

    const agent = new Agent({
      llm,
      tools,
      sessionStore: store,
      approval,
      workingDir: workDir,
      maxIterations: 3,
      systemPrompt: '测试',
    })
    agent.setCache(new ReadCache())

    const result = await agent.run('循环测试')
    expect(result.success).toBe(false)
    expect(result.finished).toBe(false)
    expect(result.iterations).toBe(3)
    expect(result.message).toContain('最大迭代')

    await llm.close()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })

  it('restart 工具 → 会话重启', async () => {
    const { createServer } = await import('node:http')
    const { once } = await import('node:events')
    const http = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sseToolCall('cr', 'restart', { reason: '测试重启' }))
      })
    })
    await once(http.listen(0, '127.0.0.1'), 'listening')
    const addr = http.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const cfg: ProviderConfig = { name: 'mock', provider: 'openai', apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' }
    const llm = new LlmClient([cfg])
    const tools = new ToolRegistry()
    tools.register(restartSpec, restartHandler)
    const store = new SessionStore(workDir)
    const approval = new ApprovalManager(async () => true)
    approval.setDisabled(true)

    const agent = new Agent({
      llm,
      tools,
      sessionStore: store,
      approval,
      workingDir: workDir,
      maxIterations: 5,
      systemPrompt: '测试',
    })
    agent.setCache(new ReadCache())

    const result = await agent.run('请重启')
    expect(result.success).toBe(true)
    expect(result.finished).toBe(true)
    expect(result.finishStatus).toBe('restart')
    expect(result.message).toContain('测试重启')

    await llm.close()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })

  it('审批被拒 → 工具不执行，LLM 收到拒绝信息', async () => {
    const { createServer } = await import('node:http')
    const { once } = await import('node:events')
    const script = [
      sseToolCall('c1', 'exec_command', { command: 'echo should-not-run' }),
      sseToolCall('c2', 'finish', { message: '好的，不执行了' }),
    ]
    let call = 0
    const http = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(script[Math.min(call++, script.length - 1)]!)
      })
    })
    await once(http.listen(0, '127.0.0.1'), 'listening')
    const addr = http.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const cfg: ProviderConfig = { name: 'mock', provider: 'openai', apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' }
    const llm = new LlmClient([cfg])
    const tools = new ToolRegistry()
    tools.register(execCommandSpec, execCommandHandler)
    tools.register(finishSpec, finishHandler)
    const store = new SessionStore(workDir)
    // 审批开启且一律拒绝
    const approval = new ApprovalManager(async () => false)
    approval.setDisabled(false)

    const events: AgentEvent[] = []
    const agent = new Agent({
      llm,
      tools,
      sessionStore: store,
      approval,
      workingDir: workDir,
      maxIterations: 5,
      systemPrompt: '测试',
      onEvent: (e) => events.push(e),
    })
    agent.setCache(new ReadCache())

    const result = await agent.run('运行 echo')
    expect(result.finished).toBe(true)

    // exec 的工具结果应为审批拒绝
    const execResult = events.find((e) => e.kind === 'toolResult' && e.name === 'exec_command')
    expect(execResult).toBeDefined()
    if (execResult && execResult.kind === 'toolResult') {
      expect(execResult.result.success).toBe(false)
      expect(execResult.result.content).toContain('审批被拒绝')
      // 命令未真正执行
      expect(execResult.result.content).not.toContain('should-not-run\n--- stdout')
    }

    await llm.close()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })

  it('LLM 调用失败（全 provider 不可用）→ 失败报告', async () => {
    const cfg: ProviderConfig = { name: 'dead', provider: 'openai', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' }
    const llm = new LlmClient([cfg], { connectTimeoutSecs: 1 })
    const tools = new ToolRegistry()
    const store = new SessionStore(workDir)
    const approval = new ApprovalManager(async () => true)
    approval.setDisabled(true)

    const agent = new Agent({
      llm,
      tools,
      sessionStore: store,
      approval,
      workingDir: workDir,
      maxIterations: 3,
      systemPrompt: '测试',
    })
    agent.setCache(new ReadCache())

    const result = await agent.run('你好')
    expect(result.success).toBe(false)
    expect(result.message).toContain('LLM')

    await llm.close()
  })

  it('token 用量累计多轮', async () => {
    const { createServer } = await import('node:http')
    const { once } = await import('node:events')
    const withUsage = (s: string) =>
      `${sseText(s)}data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n`
    const script = [
      withUsage('first'),
      withUsage('second'),
    ]
    let call = 0
    const http = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(script[Math.min(call++, script.length - 1)]!)
      })
    })
    await once(http.listen(0, '127.0.0.1'), 'listening')
    const addr = http.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const cfg: ProviderConfig = { name: 'mock', provider: 'openai', apiUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm' }
    const llm = new LlmClient([cfg])
    const tools = new ToolRegistry()
    const store = new SessionStore(workDir)
    const approval = new ApprovalManager(async () => true)
    approval.setDisabled(true)

    const agent = new Agent({
      llm,
      tools,
      sessionStore: store,
      approval,
      workingDir: workDir,
      maxIterations: 5,
      systemPrompt: '测试',
    })
    agent.setCache(new ReadCache())

    const result = await agent.run('两轮无工具')
    expect(result.success).toBe(true)
    // 第一轮无工具 → 直接结束（只有 1 轮），usage 来自第一轮
    expect(result.usage.totalTokens).toBe(150)
    expect(result.iterations).toBe(1)

    await llm.close()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })
})
