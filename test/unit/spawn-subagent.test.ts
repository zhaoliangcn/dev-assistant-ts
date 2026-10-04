import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isAppError, AppError } from '../../src/utils/error.js'
import { ReadCache } from '../../src/tools/cache.js'
import { MAX_SUBAGENT_DEPTH, spawnSubagentHandler, spawnSubagentSpec } from '../../src/tools/subagent/spawn-subagent.js'
import type { ToolContext, ToolResult } from '../../src/tools/registry.js'
import type { Agent, AgentOptions, AgentResult } from '../../src/agent/agent.js'

/**
 * spawn_subagent handler 单测。
 *
 * handler 内部通过动态 import 引入 Agent（循环依赖规避）与 subagentTools，
 * 这里用 vi.mock 拦截这两个模块，聚焦 handler 自身逻辑：
 * 参数校验、深度上限、maxIterations 钳制、子代理选项组装与结果拼接。
 * Agent.run 的真实循环在 agent 相关测试中覆盖。
 */

const mocks = vi.hoisted(() => ({
  AgentCtor: vi.fn(),
  run: vi.fn(),
  setCache: vi.fn(),
  subagentTools: vi.fn(),
}))

vi.mock('../../src/agent/agent.js', () => ({ Agent: mocks.AgentCtor }))
vi.mock('../../src/app.js', () => ({ subagentTools: mocks.subagentTools }))

interface ParentShape {
  depth: number
  llm: unknown
  tools: unknown
  sessionStore: unknown
  approval: { isDisabled: () => boolean }
}

function makeParent(overrides: Partial<ParentShape> = {}): ParentShape {
  return {
    depth: 0,
    llm: { tag: 'parent-llm' },
    tools: { tag: 'parent-registry' },
    sessionStore: { tag: 'session-store' },
    approval: { isDisabled: () => false },
    ...overrides,
  }
}

function makeCtx(parent: ParentShape | undefined): ToolContext {
  return { workingDir: '/virtual/workdir', cache: new ReadCache(), sessionId: 'sess-1', agent: parent as unknown as Agent }
}

function fakeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    message: '已整理 3 个文件，未尽事项：无',
    finished: true,
    finishStatus: 'success',
    iterations: 3,
    usage: { totalTokens: 42 } as AgentResult['usage'],
    ...overrides,
  }
}

function ctorOpts(): AgentOptions {
  const calls = mocks.AgentCtor.mock.calls
  return calls[calls.length - 1]?.[0] as AgentOptions
}

async function run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  return spawnSubagentHandler({ arguments: args }, context)
}

beforeEach(() => {
  mocks.AgentCtor.mockReset()
  mocks.run.mockReset()
  mocks.setCache.mockReset()
  mocks.subagentTools.mockReset()
  mocks.AgentCtor.mockImplementation(() => ({ run: mocks.run, setCache: mocks.setCache }) as unknown as Agent)
  mocks.subagentTools.mockImplementation((parent: unknown) => ({ __childRegistry: true, parent }))
})

// ---------------------------------------------------------------------------

describe('spawn_subagent 参数校验', () => {
  it('spec 元信息与深度常量', () => {
    expect(spawnSubagentSpec.name).toBe('spawn_subagent')
    expect(spawnSubagentSpec.dangerLevel).toBe('medium')
    expect(spawnSubagentSpec.approvalType).toBe('session')
    expect(spawnSubagentSpec.approvalScope).toBe('none')
    expect((spawnSubagentSpec.parameters as { required?: string[] }).required).toEqual(['task'])
    expect(MAX_SUBAGENT_DEPTH).toBe(3)
  })

  it('缺少 task 参数', async () => {
    const r = await run({}, makeCtx(makeParent()))
    expect(r.success).toBe(false)
    expect(r.content).toBe('缺少参数 task（子任务描述）')
    expect(r.errorCategory).toBe('permanent')
    expect(mocks.AgentCtor).not.toHaveBeenCalled()
  })

  it('task 为空字符串视为缺省', async () => {
    const r = await run({ task: '   ' }, makeCtx(makeParent()))
    expect(r.content).toBe('缺少参数 task（子任务描述）')
  })

  it('无所属 Agent 上下文', async () => {
    const r = await run({ task: 'x' }, makeCtx(undefined))
    expect(r.success).toBe(false)
    expect(r.content).toBe('spawn_subagent 只能在 Agent 运行上下文中使用')
  })
})

describe('spawn_subagent 深度上限', () => {
  it('depth=3 的父代理派生 childDepth=4：抛 AppError(subagent)', async () => {
    const err: unknown = await run({ task: 'x' }, makeCtx(makeParent({ depth: 3 }))).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isAppError(err)).toBe(true)
    const appErr = err as AppError
    expect(appErr.kind).toBe('subagent')
    expect(appErr.message).toBe('子代理深度超限（depth=4，最大 3）')
    expect(mocks.AgentCtor).not.toHaveBeenCalled()
  })

  it('depth=2 的父代理派生 childDepth=3：允许（边界）', async () => {
    mocks.run.mockResolvedValue(fakeResult())
    const r = await run({ task: '边界任务' }, makeCtx(makeParent({ depth: 2 })))
    expect(r.success).toBe(true)
    expect(r.content).toContain('子代理执行完成（depth=3，')
    expect(ctorOpts().depth).toBe(3)
  })
})

describe('spawn_subagent 子代理组装', () => {
  it('成功路径：默认 maxIterations=8，选项共享父代理资源', async () => {
    const parent = makeParent()
    mocks.run.mockResolvedValue(fakeResult())

    const r = await run({ task: '把测试目录整理干净' }, makeCtx(parent))

    expect(r.success).toBe(true)
    expect(r.errorCategory).toBeUndefined()
    expect(r.restartRequested).toBe(false)
    expect(r.content).toBe(
      '子代理执行完成（depth=1，3 轮，usage=42 tokens）\n' +
        '结束状态: success\n' +
        '--- 子代理总结 ---\n已整理 3 个文件，未尽事项：无',
    )

    // subagentTools(parent.tools) 的返回值直接作为子代理工具集
    expect(mocks.subagentTools).toHaveBeenCalledTimes(1)
    expect(mocks.subagentTools).toHaveBeenCalledWith(parent.tools)

    const opts = ctorOpts()
    expect(mocks.AgentCtor).toHaveBeenCalledTimes(1)
    expect(opts.llm).toBe(parent.llm)
    expect(opts.tools).toEqual({ __childRegistry: true, parent: parent.tools })
    expect(opts.sessionStore).toBe(parent.sessionStore)
    expect(opts.approval).toBe(parent.approval)
    expect(opts.workingDir).toBe('/virtual/workdir')
    expect(opts.maxIterations).toBe(8)
    expect(opts.depth).toBe(1)
    // 系统提示词：会话 id + 子代理指令 + 任务文本
    expect(opts.systemPrompt).toContain('会话 ID: sess-1')
    expect(opts.systemPrompt).toContain('你是一名子代理')
    expect(opts.systemPrompt).toContain('任务: 把测试目录整理干净')

    // 独立缓存先于 run 设置
    expect(mocks.setCache).toHaveBeenCalledTimes(1)
    expect(mocks.setCache.mock.calls[0]?.[0]).toBeInstanceOf(ReadCache)
    expect(mocks.setCache.mock.invocationCallOrder[0]).toBeLessThan(mocks.run.mock.invocationCallOrder[0])
  })

  it('maxIterations 钳制到 [1, 20]', async () => {
    mocks.run.mockResolvedValue(fakeResult())
    const cases: Array<{ input: unknown; expected: number }> = [
      { input: 100, expected: 20 },
      { input: '15', expected: 15 },
      { input: 0, expected: 1 },
      { input: -5, expected: 1 },
      { input: undefined, expected: 8 },
    ]
    for (const c of cases) {
      await run({ task: 'x', maxIterations: c.input }, makeCtx(makeParent()))
      expect(ctorOpts().maxIterations).toBe(c.expected)
    }
  })
})

describe('spawn_subagent 结果拼接', () => {
  it('失败结果：前置警告 + permanent 分类', async () => {
    mocks.run.mockResolvedValue(fakeResult({ success: false, finishStatus: 'failed', message: '中途失败' }))
    const r = await run({ task: 'x' }, makeCtx(makeParent()))
    expect(r.success).toBe(false)
    expect(r.errorCategory).toBe('permanent')
    expect(r.content.startsWith('⚠️ 子代理未成功完成\n')).toBe(true)
    expect(r.content).toContain('结束状态: failed')
    expect(r.content).toContain('--- 子代理总结 ---\n中途失败')
  })

  it('finishStatus=restart 不输出结束状态行', async () => {
    mocks.run.mockResolvedValue(fakeResult({ finishStatus: 'restart' }))
    const r = await run({ task: 'x' }, makeCtx(makeParent()))
    expect(r.content).not.toContain('结束状态')
    expect(r.content).toContain('子代理执行完成（depth=1，3 轮，usage=42 tokens）')
  })

  it('未 finished 也不输出结束状态行', async () => {
    mocks.run.mockResolvedValue(fakeResult({ finished: false, finishStatus: undefined }))
    const r = await run({ task: 'x' }, makeCtx(makeParent()))
    expect(r.content).not.toContain('结束状态')
    expect(r.content).toContain('--- 子代理总结 ---')
  })

  it('child.run reject 时异常上抛（由上层 registry.execute 统一包装为失败结果）', async () => {
    mocks.run.mockRejectedValue(new Error('子代理内部爆炸'))
    await expect(run({ task: 'x' }, makeCtx(makeParent()))).rejects.toThrow('子代理内部爆炸')
  })

  it('usage 与轮次插值', async () => {
    mocks.run.mockResolvedValue(fakeResult({ iterations: 7, usage: { totalTokens: 1234 } as AgentResult['usage'] }))
    const r = await run({ task: 'x' }, makeCtx(makeParent()))
    expect(r.content).toContain('子代理执行完成（depth=1，7 轮，usage=1234 tokens）')
  })
})
