import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ContextManager } from '../../src/agent/context.js'
import { compressContext, isCompressionWorthwhile, previewCompression } from '../../src/agent/compressor.js'
import { summarizeMessages, estimateMessagesTokensForSummary } from '../../src/agent/summary.js'
import { Memory } from '../../src/agent/memory.js'
import type { LlmClient } from '../../src/llm/client.js'
import type { LlmMessage, LlmResponse, ToolSchema } from '../../src/llm/models.js'

/**
 * Phase 3 上下文管理测试：compressor / summary / memory。
 * 使用假 LlmClient（对象字面量满足 call/callStream 签名）。
 */

/** 构造假 LLM：call 返回固定摘要文本 */
function fakeLlm(summaryText: string, opts: { fail?: boolean } = {}): LlmClient {
  return {
    call: async (_messages: LlmMessage[], _tools: ToolSchema[] = []): Promise<LlmResponse> => {
      if (opts.fail) throw new Error('llm boom')
      return { kind: 'text', content: summaryText }
    },
    callStream: async function* () {
      yield { kind: 'chunk', content: summaryText }
      yield { kind: 'done' }
    },
  } as unknown as LlmClient
}

function buildContext(maxTokens: number): ContextManager {
  const cm = new ContextManager(maxTokens, '你是助手')
  return cm
}

/** 填充 N 条 user/assistant 对话消息 */
function fillDialog(cm: ContextManager, n: number): void {
  for (let i = 0; i < n; i++) {
    cm.appendUser(`用户问题 ${i}: ${'x'.repeat(80)}`)
    cm.appendAssistant(`助手回答 ${i}: ${'y'.repeat(80)}`)
  }
}

describe('compressor', () => {
  it('消息太少时跳过压缩', async () => {
    const cm = buildContext(1000)
    cm.appendUser('a')
    cm.appendAssistant('b')
    const result = await compressContext(cm, fakeLlm('摘要'))
    expect(result.compressedCount).toBe(0)
    expect(result.beforeTokens).toBe(result.afterTokens)
  })

  it('压缩后 token 显著下降且保留近期消息', async () => {
    const cm = buildContext(2000)
    fillDialog(cm, 30) // 60 条消息
    const before = cm.totalTokens()

    const result = await compressContext(cm, fakeLlm('目标: 测试任务。已完成: 30 轮对话。'))

    expect(result.compressedCount).toBeGreaterThan(0)
    expect(result.keptRecentCount).toBeGreaterThanOrEqual(4)
    expect(result.afterTokens).toBeLessThan(before)
    expect(result.degraded).toBe(false)

    // 近期消息保留
    const after = cm.toMessages()
    const userMsgs = after.filter((m) => m.role === 'user')
    expect(userMsgs.some((m) => (m.content ?? '').includes('用户问题 29'))).toBe(true)

    // 压缩摘要作为 system 消息注入
    const summarySystem = after.find((m) => m.role === 'system' && (m.content ?? '').includes('压缩摘要'))
    expect(summarySystem).toBeDefined()
  })

  it('LLM 摘要失败时降级为本地摘要', async () => {
    const cm = buildContext(2000)
    fillDialog(cm, 20)
    const result = await compressContext(cm, fakeLlm('', { fail: true }))
    expect(result.degraded).toBe(true)
    expect(result.summary).toContain('本地摘要')
    // 上下文仍重建成功
    expect(cm.toMessages().length).toBeGreaterThan(0)
  })

  it('isCompressionWorthwhile 阈值判断', () => {
    const cm = buildContext(1000)
    expect(isCompressionWorthwhile(cm)).toBe(false) // 空上下文
    fillDialog(cm, 30)
    expect(isCompressionWorthwhile(cm, 0.1)).toBe(true)
  })

  it('previewCompression 预测条数', () => {
    const cm = buildContext(10_000)
    fillDialog(cm, 20) // 40 条
    const preview = previewCompression(cm)
    expect(preview.recentCount).toBeGreaterThanOrEqual(4)
    expect(preview.olderCount + preview.recentCount).toBe(40)
  })
})

describe('summary', () => {
  it('summarizeMessages 调用 LLM 生成摘要', async () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: '问题一' },
      { role: 'assistant', content: '回答一' },
    ]
    const llm = fakeLlm('目标: 测试。已完成: 无。')
    const summary = await summarizeMessages(messages, llm)
    expect(summary).toBe('目标: 测试。已完成: 无。')
  })

  it('LLM 失败时降级本地摘要（保留关键内容）', async () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: '帮我修 src/main.ts 的 bug' },
      { role: 'assistant', content: '已修复' },
    ]
    const summary = await summarizeMessages(messages, fakeLlm('', { fail: true }))
    expect(summary).toContain('摘要生成失败')
    expect(summary).toContain('src/main.ts')
  })

  it('空消息列表返回占位', async () => {
    expect(await summarizeMessages([], fakeLlm('x'))).toBe('（空）')
  })

  it('estimateMessagesTokensForSummary 累加', () => {
    const messages: LlmMessage[] = [
      { role: 'user', content: 'a'.repeat(40) },
      { role: 'assistant', content: 'b'.repeat(40) },
    ]
    expect(estimateMessagesTokensForSummary(messages)).toBeGreaterThanOrEqual(20)
  })
})

describe('Memory', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-memory-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('新增 + 持久化 + 重新加载', async () => {
    const m = new Memory(dir)
    await m.load()
    expect(m.size).toBe(0)

    await m.add('项目使用 pnpm 管理依赖')
    await m.add('构建命令是 npm run build')
    expect(m.size).toBe(2)

    // 新实例从磁盘加载
    const m2 = new Memory(dir)
    await m2.load()
    expect(m2.size).toBe(2)
    expect(m2.all().map((e) => e.content)).toContain('项目使用 pnpm 管理依赖')
  })

  it('去重：相同内容不重复添加', async () => {
    const m = new Memory(dir)
    await m.load()
    await m.add('项目使用 pnpm 管理依赖') // 已存在
    expect(m.size).toBe(2)
  })

  it('查询（大小写不敏感子串）', async () => {
    const m = new Memory(dir)
    await m.load()
    const hits = m.query('PNPM')
    expect(hits.length).toBe(1)
    expect(hits[0]!.content).toContain('pnpm')
  })

  it('内容超长时截断到 500 字符', async () => {
    const m = new Memory(dir)
    await m.load()
    await m.add('长'.repeat(800))
    const entry = m.all().find((e) => e.content.startsWith('长'))
    expect(entry).toBeDefined()
    expect(entry!.content.length).toBe(500)
  })

  it('空内容抛错', async () => {
    const m = new Memory(dir)
    await m.load()
    await expect(m.add('   ')).rejects.toThrow()
  })

  it('删除与清空', async () => {
    const m = new Memory(dir)
    await m.load()
    const before = m.size
    const first = m.all()[0]!
    await m.remove(first.id)
    expect(m.size).toBe(before - 1)
    await m.clear()
    expect(m.size).toBe(0)

    // 磁盘文件也已清空
    const raw = await readFile(m.filePath, 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ entries: [] })
  })

  it('上限淘汰最旧（MAX_ENTRIES=50）', async () => {
    const m = new Memory(dir)
    await m.load()
    for (let i = 0; i < 55; i++) {
      await m.add(`条目 ${i}`)
    }
    expect(m.size).toBe(50)
    // 最旧的被淘汰（精确匹配内容，避免 "条目 4" 命中 "条目 40" 子串）
    expect(m.all().find((e) => e.content === '条目 0')).toBeUndefined()
    expect(m.all().find((e) => e.content === '条目 4')).toBeUndefined()
    expect(m.all().find((e) => e.content === '条目 5')).toBeDefined()
    expect(m.all().find((e) => e.content === '条目 54')).toBeDefined()
  })

  it('toPromptSection：无记忆返回 undefined，有记忆渲染列表', async () => {
    const empty = new Memory(dir)
    await empty.load()
    if (empty.size === 0) {
      expect(empty.toPromptSection()).toBeUndefined()
    }
    const m = new Memory(dir)
    await m.load()
    expect(m.toPromptSection()).toContain('条目')
  })

  it('损坏的记忆文件重置为空', async () => {
    const sub = path.join(dir, 'corrupt')
    await mkdir(sub, { recursive: true })
    await writeFile(path.join(sub, '.dev-assistant-memory.json'), '{broken json', 'utf8')
    const m = new Memory(sub)
    await m.load()
    expect(m.size).toBe(0)
    // 之后可正常写入
    await m.add('新条目')
    expect(m.size).toBe(1)
  })
})
