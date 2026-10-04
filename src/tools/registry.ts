import type { ToolSchema } from '../llm/models.js'
import type { SecurityEvaluation } from '../security/types.js'
import { AppError } from '../utils/error.js'
import type { ToolSpec } from './spec.js'
import type { ReadCache } from './cache.js'
import type { HookManager } from '../hooks/manager.js'
import type { ErrorCategory } from './error.js'
import type { Agent } from '../agent/agent.js'
import type { SchedulerEngine } from '../scheduler/engine.js'

/**
 * ToolRegistry：工具注册 + 执行 + 安全评估。
 *
 * 执行流程（对齐设计文档 3.1 数据流）：
 *   execute_tool(name, argsJson)
 *     ├─ SecurityPolicy.evaluate(spec, args)  ← 危险级别评估
 *     ├─ ApprovalManager.check(...)          ← 审批检查（若需要）
 *     └─ handler(args, context)              ← 实际执行
 *
 * 单线程模型：工具执行串行化（Agent 侧 for-await 逐个执行），
 * 上下文修改天然无竞争。
 */

export interface ToolArgs {
  arguments: Record<string, unknown>
}

/** 工具执行上下文（注入给 handler） */
export interface ToolContext {
  workingDir: string
  /** 自身源码根（dev-assistant-ts 自身，用于自修改场景；Phase 2 未用） */
  selfSourceRoot?: string
  cache: ReadCache
  hooks?: HookManager
  /** 当前会话 id（持久化用） */
  sessionId?: string
  /** 中止信号 */
  signal?: AbortSignal
  /** 所属 Agent（context-budget / spawn_subagent 工具访问上下文与 LLM；type-only 避免循环） */
  agent?: Agent
  /** 调度引擎（scheduler 工具族用；App 注入，type-only 避免循环） */
  scheduler?: SchedulerEngine
}

export interface ToolResult {
  success: boolean
  content: string
  securityEvaluation?: SecurityEvaluation
  /** 请求 Agent 重启（restart 工具） */
  restartRequested: boolean
  errorCategory?: ErrorCategory
}

export type ToolHandler = (args: ToolArgs, context: ToolContext) => Promise<ToolResult>

export interface RegisteredTool {
  spec: ToolSpec
  handler: ToolHandler
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()

  /** 注册工具 */
  register(spec: ToolSpec, handler: ToolHandler): void {
    if (this.tools.has(spec.name)) {
      throw AppError.Internal(`工具重复注册: ${spec.name}`)
    }
    this.tools.set(spec.name, { spec, handler })
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  listNames(): string[] {
    return [...this.tools.keys()]
  }

  /** 生成发给 LLM 的工具 schema 列表 */
  getToolSchemas(): ToolSchema[] {
    return [...this.tools.values()].map(({ spec }) => ({
      type: 'function' as const,
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    }))
  }

  /**
   * 执行工具（含安全评估 + 审批）。
   * @param name 工具名
   * @param argsJson LLM 产出的参数 JSON 字符串
   * @param context 执行上下文
   * @param approval 审批检查回调（由 Agent 注入，避免 registry 直依赖 ApprovalManager）
   */
  async execute(
    name: string,
    argsJson: string,
    context: ToolContext,
    approval?: (evaluation: SecurityEvaluation) => Promise<boolean>,
  ): Promise<ToolResult> {
    const registered = this.tools.get(name)
    if (!registered) {
      return {
        success: false,
        content: `未知工具: ${name}（可用: ${this.listNames().join(', ')}）`,
        restartRequested: false,
        errorCategory: 'permanent',
      }
    }
    const { spec, handler } = registered

    // 宽容解析参数
    const { args, warning } = lenientParseArgsLocal(argsJson)

    // 安全评估
    let securityEvaluation: SecurityEvaluation | undefined
    if (!spec.skipSecurity) {
      securityEvaluation = evaluateTool(spec, args)
      if (securityEvaluation.approvalRequirement && approval) {
        const scope = approvalScopeKey(spec, args)
        let approved: boolean
        try {
          approved = await approval(securityEvaluation)
        } catch (e) {
          // 审批子系统自身故障（区别于用户拒绝）：execute 契约是永远返回 ToolResult
          const msg = e instanceof Error ? e.message : String(e)
          return {
            success: false,
            content: `审批检查失败: ${msg}`,
            securityEvaluation,
            restartRequested: false,
            errorCategory: 'transient',
          }
        }
        if (!approved) {
          return {
            success: false,
            content: `审批被拒绝: ${securityEvaluation.reasons.join('; ') || spec.name}（scope=${scope}）`,
            securityEvaluation,
            restartRequested: false,
            errorCategory: 'permanent',
          }
        }
      }
    }

    try {
      if (context.signal?.aborted) {
        return {
          success: false,
          content: '工具执行被取消',
          restartRequested: false,
          errorCategory: 'transient',
        }
      }
      const result = await handler({ arguments: args }, context)
      if (warning) {
        result.content = `⚠️ ${warning}\n\n${result.content}`
      }
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const category: ErrorCategory =
        e instanceof ToolError ? e.category : e instanceof AppError ? (e.kind === 'io' ? 'transient' : 'permanent') : 'permanent'
      return {
        success: false,
        content: `工具执行错误: ${msg}`,
        securityEvaluation,
        restartRequested: false,
        errorCategory: category,
      }
    }
  }
}

// 本地引用（避免 common.ts 循环导入感知）
import { lenientParseArgs as lenientParseArgsLocal } from './common.js'
import { ToolError } from './error.js'
import { evaluateTool, approvalScopeKey } from '../security/policy.js'
