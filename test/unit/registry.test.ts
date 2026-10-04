import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../../src/tools/registry.js'
import { ToolError } from '../../src/tools/error.js'
import { ReadCache } from '../../src/tools/cache.js'
import { AppError } from '../../src/utils/error.js'
import type { ToolArgs, ToolContext, ToolHandler, ToolResult } from '../../src/tools/registry.js'
import type { ToolSpec } from '../../src/tools/spec.js'
import type { SecurityEvaluation } from '../../src/security/types.js'

/**
 * ToolRegistry 单元测试：注册/schema/宽容参数解析/安全评估 + 审批/取消/错误分类。
 * 只用内存里的假 handler，不依赖任何真实工具实现与文件系统。
 */

function makeSpec(overrides: Partial<ToolSpec> & { name: string }): ToolSpec {
  return {
    description: `${overrides.name} 的测试描述`,
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
    dangerLevel: 'low',
    ...overrides,
  }
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return { workingDir: '/virtual/workdir', cache: new ReadCache(), ...overrides }
}

/** 回显 handler：记录收到的 arguments 与 context，便于断言透传行为 */
interface Seen {
  args?: Record<string, unknown>
  ctx?: ToolContext
  calls: number
}

function echoHandler(seen: Seen, content = 'done'): ToolHandler {
  return async (args: ToolArgs, ctx: ToolContext): Promise<ToolResult> => {
    seen.calls += 1
    seen.args = args.arguments
    seen.ctx = ctx
    return { success: true, content: `${content}:${JSON.stringify(args.arguments)}`, restartRequested: false }
  }
}

function throwingHandler(error: unknown): ToolHandler {
  return async (): Promise<ToolResult> => {
    throw error
  }
}

/** 记录审批入参的回调 */
interface ApprovalProbe {
  calls: SecurityEvaluation[]
  approved: boolean
}

function makeApproval(probe: ApprovalProbe): (evaluation: SecurityEvaluation) => Promise<boolean> {
  return async (evaluation: SecurityEvaluation) => {
    probe.calls.push(evaluation)
    return probe.approved
  }
}

function newRegistry(spec: ToolSpec, handler: ToolHandler): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(spec, handler)
  return registry
}

describe('ToolRegistry 注册与查询', () => {
  it('register 后 has/get 命中同一份 spec 与 handler', () => {
    const registry = new ToolRegistry()
    const spec = makeSpec({ name: 'echo' })
    const handler = echoHandler({ calls: 0 })
    registry.register(spec, handler)

    expect(registry.has('echo')).toBe(true)
    expect(registry.has('nope')).toBe(false)
    const registered = registry.get('echo')
    expect(registered?.spec).toBe(spec)
    expect(registered?.handler).toBe(handler)
    expect(registry.get('nope')).toBeUndefined()
  })

  it('listNames 与 getToolSchemas 保持注册顺序', () => {
    const registry = new ToolRegistry()
    const handler = echoHandler({ calls: 0 })
    registry.register(makeSpec({ name: 'first' }), handler)
    registry.register(makeSpec({ name: 'second' }), handler)

    expect(registry.listNames()).toEqual(['first', 'second'])
    expect(registry.getToolSchemas().map((s) => s.function.name)).toEqual(['first', 'second'])
  })

  it('重复注册抛 kind=internal 的 AppError', () => {
    const registry = new ToolRegistry()
    const handler = echoHandler({ calls: 0 })
    registry.register(makeSpec({ name: 'dup' }), handler)

    let caught: unknown
    try {
      registry.register(makeSpec({ name: 'dup' }), handler)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).kind).toBe('internal')
    expect((caught as AppError).message).toBe('工具重复注册: dup')
    // 原注册未被覆盖
    expect(registry.listNames()).toEqual(['dup'])
  })

  it('空注册表：listNames/getToolSchemas 返回空数组', () => {
    const registry = new ToolRegistry()
    expect(registry.listNames()).toEqual([])
    expect(registry.getToolSchemas()).toEqual([])
    expect(registry.has('anything')).toBe(false)
  })

  it('getToolSchemas 包装为 function 类型并透传 description/parameters', () => {
    const parameters = { type: 'object', required: ['value'], properties: { value: { type: 'string' } } }
    const registry = newRegistry(makeSpec({ name: 'schema_tool', description: '带 schema 的工具', parameters }), echoHandler({ calls: 0 }))

    expect(registry.getToolSchemas()).toEqual([
      { type: 'function', function: { name: 'schema_tool', description: '带 schema 的工具', parameters } },
    ])
  })
})

describe('ToolRegistry.execute 未知工具', () => {
  it('未知工具返回 permanent 错误并列出可用工具', async () => {
    const registry = new ToolRegistry()
    registry.register(makeSpec({ name: 'alpha' }), echoHandler({ calls: 0 }))
    registry.register(makeSpec({ name: 'beta' }), echoHandler({ calls: 0 }))

    const result = await registry.execute('gamma', '{}', makeContext())
    expect(result.success).toBe(false)
    expect(result.content).toBe('未知工具: gamma（可用: alpha, beta）')
    expect(result.errorCategory).toBe('permanent')
    expect(result.restartRequested).toBe(false)
    expect(result.securityEvaluation).toBeUndefined()
  })

  it('注册表为空时可用工具列表为空串', async () => {
    const result = await new ToolRegistry().execute('x', '{}', makeContext())
    expect(result.content).toBe('未知工具: x（可用: ）')
  })
})

describe('ToolRegistry.execute 宽容参数解析', () => {
  const seen = (): Seen => ({ calls: 0 })

  it('标准 JSON 对象直接透传', async () => {
    const log = seen()
    const registry = newRegistry(makeSpec({ name: 'echo' }), echoHandler(log))
    const result = await registry.execute('echo', '{"value":"hi"}', makeContext())

    expect(result.success).toBe(true)
    expect(result.content).toBe('done:{"value":"hi"}')
    expect(log.args).toEqual({ value: 'hi' })
    // 无 warning 时不加前缀
    expect(result.content).not.toContain('⚠️')
  })

  it('空参数串解析为空对象', async () => {
    const log = seen()
    const registry = newRegistry(makeSpec({ name: 'echo' }), echoHandler(log))
    const result = await registry.execute('echo', '', makeContext())
    expect(result.content).toBe('done:{}')
    expect(log.args).toEqual({})
    expect(result.content).not.toContain('⚠️')
  })

  it('数组参数：告警且 args 降级为空对象', async () => {
    const log = seen()
    const registry = newRegistry(makeSpec({ name: 'echo' }), echoHandler(log))
    const result = await registry.execute('echo', '[1,2]', makeContext())
    expect(log.args).toEqual({})
    expect(result.content).toBe('⚠️ 工具参数应为 JSON 对象，实际为 数组\n\ndone:{}')
  })

  it('标量参数：告警提示实际类型', async () => {
    const registry = newRegistry(makeSpec({ name: 'echo' }), echoHandler(seen()))
    const result = await registry.execute('echo', '"just-a-string"', makeContext())
    expect(result.content).toContain('工具参数应为 JSON 对象，实际为 string')
  })

  it('markdown 围栏参数：自动清理并加告警前缀', async () => {
    const log = seen()
    const registry = newRegistry(makeSpec({ name: 'echo' }), echoHandler(log))
    const result = await registry.execute('echo', '```json\n{"value": 1}\n```', makeContext())
    expect(log.args).toEqual({ value: 1 })
    expect(result.content).toBe('⚠️ 工具参数含 markdown 围栏，已自动清理\n\ndone:{"value":1}')
  })

  it('缺少外层花括号：自动补全', async () => {
    const log = seen()
    const registry = newRegistry(makeSpec({ name: 'echo' }), echoHandler(log))
    const result = await registry.execute('echo', '"value": "整个仓库"', makeContext())
    expect(log.args).toEqual({ value: '整个仓库' })
    expect(result.content).toContain('工具参数缺少外层花括号，已自动补全')
  })

  it('键未加引号：自动修复', async () => {
    const log = seen()
    const registry = newRegistry(makeSpec({ name: 'echo' }), echoHandler(log))
    const result = await registry.execute('echo', 'value: "仓库"', makeContext())
    expect(log.args).toEqual({ value: '仓库' })
    expect(result.content).toContain('工具参数键未加引号，已自动修复')
  })

  it('完全无法解析：兜底告警且 args 为空对象', async () => {
    const log = seen()
    const registry = newRegistry(makeSpec({ name: 'echo' }), echoHandler(log))
    const result = await registry.execute('echo', 'not json at all', makeContext())
    expect(log.args).toEqual({})
    expect(result.content).toContain('⚠️ 工具参数 JSON 解析失败')
  })

  it('handler 抛错时不附加参数告警前缀', async () => {
    const registry = newRegistry(makeSpec({ name: 'boom' }), throwingHandler(new Error('炸了')))
    const result = await registry.execute('boom', '[1]', makeContext())
    expect(result.success).toBe(false)
    expect(result.content).toBe('工具执行错误: 炸了')
    expect(result.content).not.toContain('⚠️')
  })

  it('handler 收到 registry 传入的同一个 context 对象', async () => {
    const log = seen()
    const registry = newRegistry(makeSpec({ name: 'echo' }), echoHandler(log))
    const ctx = makeContext({ sessionId: 'sess-1' })
    await registry.execute('echo', '{}', ctx)
    expect(log.ctx).toBe(ctx)
    expect(log.ctx?.sessionId).toBe('sess-1')
    expect(log.calls).toBe(1)
  })
})

describe('ToolRegistry.execute 安全评估与审批', () => {
  it('low 级别工具无审批回调时直接执行（成功结果原样透出，不注入评估）', async () => {
    const log: Seen = { calls: 0 }
    const registry = newRegistry(makeSpec({ name: 'list_dir', dangerLevel: 'low' }), echoHandler(log))
    const result = await registry.execute('list_dir', '{}', makeContext())

    expect(result.success).toBe(true)
    expect(log.calls).toBe(1)
    // registry 只在拒绝/异常分支带上 securityEvaluation，成功分支原样返回 handler 结果
    expect(result.securityEvaluation).toBeUndefined()
  })

  it('评估结果按危险级别映射审批要求（通过拒绝分支可观测）', async () => {
    const probe: ApprovalProbe = { calls: [], approved: true }
    const registry = newRegistry(makeSpec({ name: 'deploy', dangerLevel: 'critical', approvalScope: 'command' }), echoHandler({ calls: 0 }))
    const result = await registry.execute('deploy', '{}', makeContext(), makeApproval(probe))

    const evaluation = probe.calls[0]
    expect(evaluation?.dangerLevel).toBe('critical')
    expect(evaluation?.reasons).toEqual(['固有级别: critical'])
    expect(evaluation?.approvalRequirement).toEqual({
      approvalType: 'one-time',
      dangerThreshold: 'critical',
      requiresUserConfirmation: true,
      validitySeconds: 0,
      scope: 'command',
    })
    // 审批通过 → 正常执行
    expect(result.success).toBe(true)
  })

  it('注入审批回调后即使 low 也会被询问（由调用方决定是否注入）', async () => {
    const probe: ApprovalProbe = { calls: [], approved: true }
    const registry = newRegistry(makeSpec({ name: 'read_file' }), echoHandler({ calls: 0 }))
    const result = await registry.execute('read_file', '{}', makeContext(), makeApproval(probe))

    expect(probe.calls).toHaveLength(1)
    expect(probe.calls[0]?.dangerLevel).toBe('low')
    expect(result.success).toBe(true)
  })

  it('审批拒绝：文案包含 reasons 与 scope，且不执行 handler', async () => {
    const log: Seen = { calls: 0 }
    const probe: ApprovalProbe = { calls: [], approved: false }
    const registry = newRegistry(
      makeSpec({ name: 'write_file', dangerLevel: 'high', approvalScope: 'file' }),
      echoHandler(log),
    )
    const result = await registry.execute('write_file', '{"path":"notes.md"}', makeContext(), makeApproval(probe))

    expect(log.calls).toBe(0)
    expect(result.success).toBe(false)
    expect(result.errorCategory).toBe('permanent')
    expect(result.content).toBe('审批被拒绝: 固有级别: high（scope=notes.md）')
    expect(result.securityEvaluation?.approvalRequirement?.scope).toBe('file')
    expect(probe.calls).toHaveLength(1)
  })

  it('审批回调自身抛错：返回 transient 失败结果而非 reject，且不执行 handler', async () => {
    const log: Seen = { calls: 0 }
    const registry = newRegistry(
      makeSpec({ name: 'write_file', dangerLevel: 'high', approvalScope: 'file' }),
      echoHandler(log),
    )
    const approval = async (): Promise<boolean> => {
      throw new Error('审批存储不可用')
    }
    const result = await registry.execute('write_file', '{"path":"notes.md"}', makeContext(), approval)

    expect(log.calls).toBe(0)
    expect(result.success).toBe(false)
    expect(result.errorCategory).toBe('transient')
    expect(result.content).toBe('审批检查失败: 审批存储不可用')
    expect(result.securityEvaluation?.approvalRequirement?.scope).toBe('file')
  })

  it('exec_command 命令风险动态升级进入拒绝文案', async () => {
    const probe: ApprovalProbe = { calls: [], approved: false }
    const registry = newRegistry(
      makeSpec({ name: 'exec_command', dangerLevel: 'medium', approvalScope: 'command' }),
      echoHandler({ calls: 0 }),
    )
    const result = await registry.execute('exec_command', '{"command":"rm -rf /tmp/x"}', makeContext(), makeApproval(probe))

    expect(result.securityEvaluation?.dangerLevel).toBe('critical')
    expect(result.content).toBe('审批被拒绝: 命令风险: critical（scope=rm -rf /tmp/x）')
  })

  it('写敏感路径时 reasons 覆盖为敏感路径提示', async () => {
    const probe: ApprovalProbe = { calls: [], approved: false }
    const registry = newRegistry(
      makeSpec({ name: 'edit_file', dangerLevel: 'high', approvalScope: 'file' }),
      echoHandler({ calls: 0 }),
    )
    const result = await registry.execute('edit_file', '{"path":".git/config"}', makeContext(), makeApproval(probe))
    expect(result.content).toBe('审批被拒绝: 敏感路径: .git/config（scope=.git/config）')
  })

  it('scope=none 的工具审批 key 回退 global', async () => {
    const probe: ApprovalProbe = { calls: [], approved: false }
    const registry = newRegistry(makeSpec({ name: 'run_all', dangerLevel: 'high' }), echoHandler({ calls: 0 }))
    const result = await registry.execute('run_all', '{"any":1}', makeContext(), makeApproval(probe))
    expect(result.content).toBe('审批被拒绝: 固有级别: high（scope=global）')
  })

  it('skipSecurity 工具跳过评估且不触发审批', async () => {
    const probe: ApprovalProbe = { calls: [], approved: false }
    const log: Seen = { calls: 0 }
    const registry = newRegistry(makeSpec({ name: 'finish', skipSecurity: true, dangerLevel: 'critical' }), echoHandler(log))
    const result = await registry.execute('finish', '{}', makeContext(), makeApproval(probe))

    expect(probe.calls).toHaveLength(0)
    expect(log.calls).toBe(1)
    expect(result.success).toBe(true)
    expect(result.securityEvaluation).toBeUndefined()
  })

  it('handler 抛错时结果仍带 securityEvaluation', async () => {
    const registry = newRegistry(
      makeSpec({ name: 'write_file', dangerLevel: 'high', approvalScope: 'file' }),
      throwingHandler(new ToolError('磁盘满', 'transient')),
    )
    const probe: ApprovalProbe = { calls: [], approved: true }
    const result = await registry.execute('write_file', '{"path":"a.txt"}', makeContext(), makeApproval(probe))

    expect(result.success).toBe(false)
    expect(result.errorCategory).toBe('transient')
    expect(result.securityEvaluation?.dangerLevel).toBe('high')
  })

  it('审批在取消检查之前执行', async () => {
    const probe: ApprovalProbe = { calls: [], approved: false }
    const log: Seen = { calls: 0 }
    const registry = newRegistry(makeSpec({ name: 'write_file', dangerLevel: 'high' }), echoHandler(log))
    const controller = new AbortController()
    controller.abort()

    const result = await registry.execute('write_file', '{}', makeContext({ signal: controller.signal }), makeApproval(probe))
    expect(probe.calls).toHaveLength(1)
    expect(result.content).toBe('审批被拒绝: 固有级别: high（scope=global）')
  })
})

describe('ToolRegistry.execute 取消', () => {
  it('signal 已 abort 时不调用 handler', async () => {
    const log: Seen = { calls: 0 }
    const registry = newRegistry(makeSpec({ name: 'echo' }), echoHandler(log))
    const controller = new AbortController()
    controller.abort()

    const result = await registry.execute('echo', '{}', makeContext({ signal: controller.signal }))
    expect(log.calls).toBe(0)
    expect(result.success).toBe(false)
    expect(result.content).toBe('工具执行被取消')
    expect(result.errorCategory).toBe('transient')
    expect(result.restartRequested).toBe(false)
  })

  it('未 abort 的 signal 正常执行', async () => {
    const log: Seen = { calls: 0 }
    const registry = newRegistry(makeSpec({ name: 'echo' }), echoHandler(log))
    const result = await registry.execute('echo', '{}', makeContext({ signal: new AbortController().signal }))
    expect(log.calls).toBe(1)
    expect(result.success).toBe(true)
  })
})

describe('ToolRegistry.execute 错误分类', () => {
  const spec = makeSpec({ name: 'boom' })

  async function runWithError(error: unknown): Promise<ToolResult> {
    const registry = newRegistry(spec, throwingHandler(error))
    return registry.execute('boom', '{}', makeContext())
  }

  it('ToolError 保留自身 category（transient / permanent / llm）', async () => {
    expect((await runWithError(ToolError.transient('临时失败'))).errorCategory).toBe('transient')
    expect((await runWithError(new ToolError('永久失败'))).errorCategory).toBe('permanent')
    expect((await runWithError(new ToolError('模型问题', 'llm'))).errorCategory).toBe('llm')
  })

  it('AppError kind=io 归为 transient，其余归为 permanent', async () => {
    expect((await runWithError(AppError.Io('读文件失败'))).errorCategory).toBe('transient')
    expect((await runWithError(AppError.Config('配置错误'))).errorCategory).toBe('permanent')
    expect((await runWithError(AppError.Tool('工具失败'))).errorCategory).toBe('permanent')
    expect((await runWithError(AppError.Internal('内部错误'))).errorCategory).toBe('permanent')
    expect((await runWithError(AppError.Llm('LLM 挂了'))).errorCategory).toBe('permanent')
  })

  it('普通 Error 与其他未知类型归为 permanent', async () => {
    const plain = await runWithError(new Error('普通异常'))
    expect(plain.errorCategory).toBe('permanent')
    expect(plain.content).toBe('工具执行错误: 普通异常')

    const str = await runWithError('字符串异常')
    expect(str.errorCategory).toBe('permanent')
    expect(str.content).toBe('工具执行错误: 字符串异常')
  })

  it('异常被吞掉后 success=false 且不带取消文案', async () => {
    const result = await runWithError(new Error('kaboom'))
    expect(result.success).toBe(false)
    expect(result.restartRequested).toBe(false)
    expect(result.content.startsWith('工具执行错误: ')).toBe(true)
  })
})

describe('ToolRegistry.execute 结果透传', () => {
  it('handler 返回的 success=false / restartRequested 原样透出', async () => {
    const registry = newRegistry(makeSpec({ name: 'restart' }), async (): Promise<ToolResult> => ({
      success: false,
      content: '需要重启',
      restartRequested: true,
      errorCategory: 'llm',
    }))
    const result = await registry.execute('restart', '{}', makeContext())
    expect(result).toEqual({ success: false, content: '需要重启', restartRequested: true, errorCategory: 'llm' })
  })

  it('skipSecurity 元工具可返回 restartRequested 且不产生评估结果', async () => {
    const registry = newRegistry(makeSpec({ name: 'restart', skipSecurity: true }), async (): Promise<ToolResult> => ({
      success: true,
      content: 'ok',
      restartRequested: true,
    }))
    const result = await registry.execute('restart', '', makeContext())
    expect(result.securityEvaluation).toBeUndefined()
    expect(result.restartRequested).toBe(true)
  })
})
