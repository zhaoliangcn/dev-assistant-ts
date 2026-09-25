import { describe, expect, it } from 'vitest'
import { estimateTokens, estimateMessagesTokens, estimateMessageTokens, estimateToolCallTokens } from '../../src/agent/token-counter.js'
import { ContextManager } from '../../src/agent/context.js'
import { buildSystemPrompt } from '../../src/prompt.js'
import type { LlmMessage, ToolCall } from '../../src/llm/models.js'

/**
 * token 估算 + ContextManager + 系统提示词测试。
 */

describe('estimateTokens', () => {
  it('空串 → 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('英文约 4 字符/token', () => {
    // 40 个 ASCII 字符 ≈ 10 tokens
    const t = estimateTokens('a'.repeat(40))
    expect(t).toBeGreaterThanOrEqual(9)
    expect(t).toBeLessThanOrEqual(11)
  })

  it('中文约 1.5 字/token', () => {
    // 30 个汉字 ≈ 20 tokens
    const t = estimateTokens('中'.repeat(30))
    expect(t).toBeGreaterThanOrEqual(19)
    expect(t).toBeLessThanOrEqual(21)
  })

  it('中英混合分别累计', () => {
    const mixed = estimateTokens('a'.repeat(40) + '中'.repeat(30))
    const ascii = estimateTokens('a'.repeat(40))
    const cjk = estimateTokens('中'.repeat(30))
    expect(mixed).toBe(ascii + cjk)
  })
})

describe('estimateMessageTokens', () => {
  it('user 消息含内容开销', () => {
    const t = estimateMessageTokens({ role: 'user', content: 'hello world' })
    expect(t).toBeGreaterThan(estimateTokens('hello world'))
  })

  it('assistant 带 tool_calls 计数更高', () => {
    const plain = estimateMessageTokens({ role: 'assistant', content: 'ok' })
    const withCalls: LlmMessage = {
      role: 'assistant',
      content: 'ok',
      toolCalls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    }
    expect(estimateMessageTokens(withCalls)).toBeGreaterThan(plain)
  })

  it('tool 结果消息含 toolCallId 开销', () => {
    const t = estimateMessageTokens({ role: 'tool', toolCallId: 'c1', content: 'result' })
    expect(t).toBeGreaterThan(estimateTokens('result'))
  })

  it('estimateToolCallTokens 随参数增长', () => {
    const small: ToolCall = { id: 'c', function: { name: 'f', arguments: '{}' } }
    const large: ToolCall = { id: 'c', function: { name: 'f', arguments: '"x".repeat(1000)' } }
    expect(estimateToolCallTokens(large)).toBeGreaterThan(estimateToolCallTokens(small))
  })

  it('estimateMessagesTokens 累加', () => {
    const msgs: LlmMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]
    const total = estimateMessagesTokens(msgs)
    const sum = msgs.reduce((acc, m) => acc + estimateMessageTokens(m), 0)
    expect(total).toBeGreaterThanOrEqual(sum) // 含数组本身开销
  })
})

describe('ContextManager', () => {
  it('初始含 system 提示词', () => {
    const cm = new ContextManager(1000, '你是助手')
    expect(cm.length).toBe(1)
    expect(cm.toMessages()[0]).toMatchObject({ role: 'system', content: '你是助手' })
  })

  it('追加消息与 token 累计', () => {
    const cm = new ContextManager(10_000)
    cm.appendUser('用户问题')
    cm.appendAssistant('助手回复')
    cm.appendToolResult('c1', '工具结果')
    expect(cm.length).toBe(3)
    expect(cm.totalTokens()).toBeGreaterThan(0)
    expect(cm.lastMessage?.role).toBe('tool')
  })

  it('budget 压力分级', () => {
    const cm = new ContextManager(1000)
    expect(cm.budget().pressure).toBe('low')

    // 填充到高压力
    cm.appendUser('x'.repeat(4000)) // ~1000 tokens
    expect(cm.budget().ratio).toBeGreaterThan(0.75)

    cm.appendUser('y'.repeat(4000))
    expect(cm.budget().pressure).toBe('critical')
    expect(cm.budget().ratio).toBeGreaterThanOrEqual(0.9)
  })

  it('pressure 边界值', () => {
    const levels = ['low', 'medium', 'high', 'critical'] as const
    for (const [ratio, expected] of [
      [0.3, 'low'],
      [0.6, 'medium'],
      [0.8, 'high'],
      [0.95, 'critical'],
    ] as const) {
      const cm = new ContextManager(1000)
      // 40 字符 ASCII ≈ 10 tokens；预留少量余量
      const chars = Math.ceil(ratio * 1000 * 0.9) * 4
      cm.appendUser('a'.repeat(chars))
      const pressure = cm.budget().pressure
      // 因估算近似性，允许与期望级别相邻
      expect(Math.abs(levels.indexOf(pressure) - levels.indexOf(expected))).toBeLessThanOrEqual(1)
    }
  })

  it('setToolsTokens 计入总预算', () => {
    const cm = new ContextManager(1000)
    const before = cm.totalTokens()
    cm.setToolsTokens(500)
    expect(cm.totalTokens()).toBe(before + 500)
  })

  it('reset 清空并可选重建 system', () => {
    const cm = new ContextManager(1000, 'sys1')
    cm.appendUser('msg')
    cm.reset('sys2')
    expect(cm.length).toBe(1)
    expect(cm.toMessages()[0]).toMatchObject({ role: 'system', content: 'sys2' })
  })

  it('resetAndRebuild 保留 system + 尾部', () => {
    const cm = new ContextManager(10_000, 'sys')
    cm.appendUser('old1')
    cm.appendAssistant('old2')
    cm.appendUser('recent')
    const all = cm.toMessages()
    const system = all.filter((m) => m.role === 'system')
    cm.resetAndRebuild(system, [all[3]!])
    expect(cm.length).toBe(2)
    expect(cm.toMessages()[0]?.role).toBe('system')
    expect(cm.toMessages()[1]).toMatchObject({ role: 'user', content: 'recent' })
  })

  it('maxTokenLimit 返回配置值', () => {
    const cm = new ContextManager(262_144)
    expect(cm.maxTokenLimit).toBe(262_144)
  })
})

describe('buildSystemPrompt', () => {
  it('包含工作目录与工具规范', () => {
    const p = buildSystemPrompt({ workingDir: '/proj', platform: 'linux' })
    expect(p).toContain('/proj')
    expect(p).toContain('linux')
    expect(p).toContain('工具使用规范')
    expect(p).toContain('finish')
  })

  it('approvalEnabled=false 时不含审批机制', () => {
    const withApproval = buildSystemPrompt({ workingDir: '/p', approvalEnabled: true })
    const without = buildSystemPrompt({ workingDir: '/p', approvalEnabled: false })
    expect(withApproval).toContain('审批机制')
    expect(without).not.toContain('审批机制')
  })

  it('技能与记忆注入', () => {
    const p = buildSystemPrompt({
      workingDir: '/p',
      skills: [{ name: 'test-skill', description: '用于测试' }],
      memory: ['项目用 pnpm 管理依赖'],
    })
    expect(p).toContain('可用技能')
    expect(p).toContain('test-skill')
    expect(p).toContain('项目记忆')
    expect(p).toContain('pnpm')
  })

  it('extraInstructions 追加', () => {
    const p = buildSystemPrompt({ workingDir: '/p', extraInstructions: ['只读模式'] })
    expect(p).toContain('补充指令')
    expect(p).toContain('只读模式')
  })
})
