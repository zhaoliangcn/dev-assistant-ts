import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { contextBudgetHandler, contextBudgetSpec } from '../../src/tools/context-budget/context-budget.js'
import { compressContextToolHandler, compressContextToolSpec } from '../../src/tools/context-budget/compress-context.js'
import { saveSummaryHandler, saveSummarySpec } from '../../src/tools/context-budget/save-summary.js'
import { Agent } from '../../src/agent/agent.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { ReadCache } from '../../src/tools/cache.js'
import { ApprovalManager } from '../../src/security/approval.js'
import { SessionStore } from '../../src/persist/session-store.js'
import type { LlmClient } from '../../src/llm/client.js'
import type { LlmMessage, LlmResponse, LlmStreamEvent, ToolSchema } from '../../src/llm/models.js'

/**
 * Phase 3 context-budget 工具测试：
 * - context_budget：预算查询输出
 * - compress_context：手动压缩 / 小上下文跳过
 * - save_summary：手动摘要落盘
 *
 * 用最小 Agent（假 LLM，call 返回固定文本；callStream 无工具调用 → 立即结束）。
 */

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-cb-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fakeLlm(text: string, opts: { fail?: boolean } = {}): LlmClient {
  return {
    call: async (_messages: LlmMessage[], _tools: ToolSchema[] = []): Promise<LlmResponse> => {
      if (opts.fail) throw new Error('llm boom')
      return { kind: 'text', content: text }
    },
    callStream: async function* (): AsyncGenerator<LlmStreamEvent> {
      yield { kind: 'chunk', content: text }
      yield { kind: 'done' }
    },
  } as unknown as LlmClient
}

function makeAgent(llm: LlmClient, opts: { maxTokens?: number } = {}): Agent {
  const store = new SessionStore(dir)
  const agent = new Agent({
    llm,
    tools: new ToolRegistry(),
    sessionStore: store,
    approval: new ApprovalManager(async () => true),
    workingDir: dir,
    maxIterations: 2,
    maxTokens: opts.maxTokens,
    systemPrompt: 'test',
  })
  return agent
}

function ctxFor(agent: Agent) {
  return {
    workingDir: dir,
    cache: new ReadCache(),
    sessionId: agent.sessionId,
    agent,
  }
}

describe('context_budget 工具', () => {
  it('specs 命名与危险级别', () => {
    expect(contextBudgetSpec.name).toBe('context_budget')
    expect(contextBudgetSpec.dangerLevel).toBe('low')
    expect(compressContextToolSpec.name).toBe('compress_context')
    expect(saveSummarySpec.name).toBe('save_summary')
  })

  it('无 Agent 上下文时报错', async () => {
    const r = await contextBudgetHandler({ arguments: {} }, { workingDir: dir, cache: new ReadCache() })
    expect(r.success).toBe(false)
  })

  it('输出预算信息（token / 压力 / 消息数）', async () => {
    const agent = makeAgent(fakeLlm('ok'))
    const r = await contextBudgetHandler({ arguments: {} }, ctxFor(agent))
    expect(r.success).toBe(true)
    expect(r.content).toContain('上下文预算')
    expect(r.content).toContain('压力级别')
    expect(r.content).toContain('消息总数')
  })
})

describe('compress_context 工具', () => {
  it('小上下文跳过压缩', async () => {
    const agent = makeAgent(fakeLlm('摘要'))
    agent.getContext().appendUser('短消息')
    const r = await compressContextToolHandler({ arguments: {} }, ctxFor(agent))
    expect(r.success).toBe(true)
    expect(r.content).toContain('压缩收益有限')
  })

  it('大上下文触发压缩且 token 下降', async () => {
    const agent = makeAgent(fakeLlm('摘要: 目标 / 已完成 / 关键决策 / 未决事项'), { maxTokens: 2000 })
    for (let i = 0; i < 30; i++) {
      agent.getContext().appendUser(`问题 ${i} ${'x'.repeat(80)}`)
      agent.getContext().appendAssistant(`回答 ${i} ${'y'.repeat(80)}`)
    }
    const before = agent.getContext().totalTokens()

    const r = await compressContextToolHandler({ arguments: {} }, ctxFor(agent))
    expect(r.success).toBe(true)
    expect(r.content).toContain('压缩完成')

    const after = agent.getContext().totalTokens()
    expect(after).toBeLessThan(before)
  })

  it('LLM 失败时压缩降级（仍成功）', async () => {
    const agent = makeAgent(fakeLlm('', { fail: true }), { maxTokens: 2000 })
    for (let i = 0; i < 30; i++) {
      agent.getContext().appendUser(`问题 ${i} ${'x'.repeat(80)}`)
      agent.getContext().appendAssistant(`回答 ${i} ${'y'.repeat(80)}`)
    }
    const r = await compressContextToolHandler({ arguments: {} }, ctxFor(agent))
    expect(r.success).toBe(true)
    expect(r.content).toContain('降级')
  })
})

describe('save_summary 工具', () => {
  it('空上下文报错', async () => {
    const agent = makeAgent(fakeLlm('摘要'))
    const r = await saveSummaryHandler({ arguments: {} }, ctxFor(agent))
    expect(r.success).toBe(false)
    expect(r.content).toContain('无对话消息')
  })

  it('保存摘要并回显内容', async () => {
    const agent = makeAgent(fakeLlm('目标: 测试摘要'))
    agent.getContext().appendUser('问题 A')
    agent.getContext().appendAssistant('回答 A')
    const r = await saveSummaryHandler({ arguments: { count: 2, note: '主题X' } }, ctxFor(agent))
    expect(r.success).toBe(true)
    expect(r.content).toContain('摘要已保存')
    expect(r.content).toContain('主题: 主题X')
    expect(r.content).toContain('目标: 测试摘要')
  })

  it('count 上限 50', async () => {
    const agent = makeAgent(fakeLlm('摘要'))
    agent.getContext().appendUser('问题 A')
    // count=999 被 clamp 到 50，但消息只有 2 条，取 tail
    const r = await saveSummaryHandler({ arguments: { count: 999 } }, ctxFor(agent))
    expect(r.success).toBe(true)
    expect(r.content).toContain('摘要已保存')
  })
})
