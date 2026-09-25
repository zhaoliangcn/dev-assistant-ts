import { describe, expect, it } from 'vitest'
import { MAX_SUBAGENT_DEPTH, spawnSubagentSpec } from '../../src/tools/subagent/spawn-subagent.js'
import { subagentTools } from '../../src/app.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import type { ToolSpec } from '../../src/tools/spec.js'
import { AppError, isAppError } from '../../src/utils/error.js'

/**
 * Phase 3 子代理测试：深度上限 + 工具集派生（subagentTools 移除 spawn_subagent）。
 * 子代理端到端执行（LLM 驱动）由 agent-loop 集成测试覆盖；这里测纯逻辑部分。
 */

describe('MAX_SUBAGENT_DEPTH', () => {
  it('深度上限为 3（设计文档约束）', () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(3)
  })

  it('AppError.SubagentDepthLimit 携带深度信息', () => {
    const err = AppError.SubagentDepthLimit(4)
    expect(isAppError(err)).toBe(true)
    expect(err.message).toContain('4')
    expect(err.message).toContain('3')
  })
})

describe('spawnSubagentSpec', () => {
  it('task 为必填参数', () => {
    expect(spawnSubagentSpec.name).toBe('spawn_subagent')
    expect(spawnSubagentSpec.parameters.required).toContain('task')
  })

  it('危险级别 medium + session 审批', () => {
    expect(spawnSubagentSpec.dangerLevel).toBe('medium')
    expect(spawnSubagentSpec.approvalType).toBe('session')
  })
})

describe('subagentTools', () => {
  function spec(name: string): ToolSpec {
    return {
      name,
      description: `test ${name}`,
      parameters: { type: 'object', properties: {} },
      dangerLevel: 'low',
    }
  }

  it('移除 spawn_subagent，保留其余工具', () => {
    const parent = new ToolRegistry()
    parent.register(spec('read_file'), async () => ({ success: true, content: '', restartRequested: false }))
    parent.register(spec('spawn_subagent'), async () => ({ success: true, content: '', restartRequested: false }))
    parent.register(spec('finish'), async () => ({ success: true, content: '', restartRequested: false }))

    const child = subagentTools(parent)
    const names = child.listNames()

    expect(names).not.toContain('spawn_subagent')
    expect(names).toContain('read_file')
    expect(names).toContain('finish')
    expect(names.length).toBe(2)
  })

  it('不修改父注册表', () => {
    const parent = new ToolRegistry()
    parent.register(spec('spawn_subagent'), async () => ({ success: true, content: '', restartRequested: false }))
    parent.register(spec('read_file'), async () => ({ success: true, content: '', restartRequested: false }))

    subagentTools(parent)
    expect(parent.listNames()).toContain('spawn_subagent')
    expect(parent.listNames().length).toBe(2)
  })

  it('空注册表 → 空子注册表', () => {
    const child = subagentTools(new ToolRegistry())
    expect(child.listNames().length).toBe(0)
  })
})
