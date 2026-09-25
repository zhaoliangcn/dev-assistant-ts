import type { LlmClient } from '../llm/client.js'
import type { LlmStreamEvent, ToolCall, TokenUsage } from '../llm/models.js'
import { ToolRegistry, type ToolContext, type ToolResult } from '../tools/registry.js'
import { ReadCache, UsageAccumulator } from '../tools/cache.js'
import type { SecurityEvaluation } from '../security/types.js'
import type { ApprovalManager } from '../security/approval.js'
import type { SessionStore } from '../persist/session-store.js'
import { nowIso } from '../persist/events.js'
import { HookManager } from '../hooks/manager.js'
import { ContextManager } from './context.js'
import { estimateToolsTokens } from './token-counter.js'
import { compressContext, isCompressionWorthwhile } from './compressor.js'
import { summarizeMessages, estimateMessagesTokensForSummary } from './summary.js'
import type { Memory } from './memory.js'
import type { SchedulerEngine } from '../scheduler/engine.js'
import { approvalScopeKey, evaluateTool as evaluateForAgent } from '../security/policy.js'
import { isFinishCall } from '../tools/meta/finish.js'
import { AppError } from '../utils/error.js'
import { log } from '../utils/logger.js'

/**
 * Agent：多轮迭代主循环（对齐设计文档 8.1）。
 *
 * 每轮迭代：
 * 1. 检查上下文预算，critical 时压缩（Phase 3 接入 compressor）
 * 2. 流式调用 LLM
 * 3. 有工具调用 → 逐个执行（安全评估 + 审批），结果回注，继续下一轮
 *    - finish 工具 → 结构化终止
 *    - restartRequested → 重置上下文重启
 * 4. 无工具调用 → 输出最终回复，结束
 */

export interface AgentOptions {
  llm: LlmClient
  tools: ToolRegistry
  sessionStore: SessionStore
  approval: ApprovalManager
  hooks?: HookManager
  workingDir: string
  maxIterations?: number
  maxTokens?: number
  systemPrompt: string
  /** 摘要间隔（每 N 轮保存一次摘要，默认 5） */
  summaryInterval?: number
  /** 子代理深度（0=父代理） */
  depth?: number
  /** 长期记忆（注入系统提示词；compress_context 工具用） */
  memory?: Memory
  /** 调度引擎（scheduler 工具族用；App 注入，type-only 避免循环） */
  scheduler?: SchedulerEngine
  /** 流式事件回调（CLI/Web 渲染用） */
  onEvent?: (event: AgentEvent) => void
  /** 上下文结构变化回调（压缩/重启后触发，供 UI 刷新状态栏） */
  onContextChanged?: () => void
  /** 审批确认展示（由 approval manager 的 confirm 回调处理，此处仅透传） */
}

export interface AgentResult {
  success: boolean
  message: string
  /** finish 工具触发（结构化终止） */
  finished: boolean
  /** finish 的状态（success/partial/failed） */
  finishStatus?: string
  iterations: number
  usage: TokenUsage
}

/** Agent 对外流式事件（供 UI 消费） */
export type AgentEvent =
  | { kind: 'assistantStreamDelta'; content: string }
  | { kind: 'reasoningDelta'; content: string }
  | { kind: 'toolCall'; call: ToolCall; security?: SecurityEvaluation }
  | { kind: 'toolResult'; callId: string; name: string; result: ToolResult }
  | { kind: 'tokenUsage'; usage: TokenUsage }
  | { kind: 'status'; content: string }
  | { kind: 'systemMessage'; content: string }

const DEFAULT_MAX_ITERATIONS = 10
const DEFAULT_SUMMARY_INTERVAL = 5

export class Agent {
  private context: ContextManager
  private usage = new UsageAccumulator()
  private iterations = 0
  private sinceLastSummary = 0

  constructor(private opts: AgentOptions) {
    this.context = new ContextManager(opts.maxTokens ?? 262_144, opts.systemPrompt)
    // 工具 schema 固定开销
    this.context.setToolsTokens(
      estimateToolsTokens(
        opts.tools.getToolSchemas().map((s) => ({
          name: s.function.name,
          description: s.function.description,
          parameters: s.function.parameters,
        })),
      ),
    )
  }

  get sessionId(): string {
    return this.opts.sessionStore.sessionId
  }

  /** 当前 ContextManager（供 context-budget 工具查询/压缩） */
  getContext(): ContextManager {
    return this.context
  }

  /** LLM 客户端（供压缩/摘要/子代理复用） */
  get llm(): LlmClient {
    return this.opts.llm
  }

  /** 运行时热替换 LLM 客户端（嵌入场景：设置页保存新模型配置后生效） */
  setLlm(llm: LlmClient): void {
    this.opts.llm = llm
  }

  /** 子代理深度（0=父代理） */
  get depth(): number {
    return this.opts.depth ?? 0
  }

  /** 审批管理器（子代理复用父审批状态） */
  get approval(): ApprovalManager {
    return this.opts.approval
  }

  /** 会话存储（子代理共享父会话持久化） */
  get sessionStore(): SessionStore {
    return this.opts.sessionStore
  }

  /** 工具注册表（子代理派生工具集用） */
  get tools(): ToolRegistry {
    return this.opts.tools
  }

  /** 执行一轮完整任务（用户消息 → 多轮迭代 → 最终回复） */
  async run(message: string): Promise<AgentResult> {
    const { sessionStore, hooks, tools, llm, approval } = this.opts
    const maxIterations = this.opts.maxIterations ?? DEFAULT_MAX_ITERATIONS
    const store = sessionStore

    // 用户消息入上下文 + 持久化
    this.context.appendUser(message)
    store.append({ type: 'user_message', timestamp: nowIso(), sessionId: this.sessionId, content: message })

    // session-start hook（仅第一次 run 触发）
    if (hooks?.isEnabled() && this.iterations === 0) {
      const results = await hooks.fire('session-start', { cwd: this.opts.workingDir, sessionId: this.sessionId })
      const injections = HookManager.collectInjection(results, hooks.list())
      for (const note of injections) {
        this.context.appendSystem(note)
        store.append({ type: 'system_message', timestamp: nowIso(), sessionId: this.sessionId, content: note })
        this.emit({ kind: 'systemMessage', content: note })
      }
    }

    const abort = new AbortController()
    const toolContext: ToolContext = {
      workingDir: this.opts.workingDir,
      cache: this.getCache(),
      hooks,
      sessionId: this.sessionId,
      signal: abort.signal,
      agent: this,
    }

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      this.iterations = iteration + 1

      // 1. 上下文预算检查：critical 时自动压缩（每轮最多一次，避免压缩循环）
      const budget = this.context.budget()
      if (budget.pressure === 'critical' && isCompressionWorthwhile(this.context)) {
        const before = this.context.totalTokens()
        this.emit({ kind: 'status', content: `上下文压力 critical（${Math.round(budget.ratio * 100)}%），自动压缩中…` })
        try {
          const cr = await compressContext(this.context, llm)
          store.append({
            type: 'context_compression',
            timestamp: nowIso(),
            sessionId: this.sessionId,
            beforeTokens: cr.beforeTokens,
            afterTokens: cr.afterTokens,
          })
          this.emit({
            kind: 'status',
            content: `上下文压缩完成：${cr.beforeTokens} → ${cr.afterTokens} tokens（蒸馏 ${cr.compressedCount} 条消息${cr.degraded ? '，LLM 摘要失败已降级' : ''}）`,
          })
          this.opts.onContextChanged?.()
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          store.append({ type: 'system_message', timestamp: nowIso(), sessionId: this.sessionId, content: `上下文压缩失败: ${msg}` })
          this.emit({ kind: 'status', content: `上下文压缩失败: ${msg}` })
          void before
        }
      }

      // 2. 周期性摘要（每 N 轮，落盘 summary_saved 供崩溃恢复）
      const summaryInterval = this.opts.summaryInterval ?? DEFAULT_SUMMARY_INTERVAL
      this.sinceLastSummary++
      if (this.sinceLastSummary >= summaryInterval && this.iterations > 1) {
        this.sinceLastSummary = 0
        try {
          const tail = this.context.tail(summaryInterval * 3)
          const summary = await summarizeMessages(tail, llm)
          const tokens = estimateMessagesTokensForSummary(tail)
          store.append({
            type: 'summary_saved',
            timestamp: nowIso(),
            sessionId: this.sessionId,
            level: 1,
            content: summary,
          })
          this.emit({ kind: 'status', content: `已保存阶段性摘要（覆盖 ${tail.length} 条消息 / 约 ${tokens} tokens）` })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          this.emit({ kind: 'status', content: `摘要保存失败: ${msg}` })
        }
      }

      // 2. 流式调用 LLM
      this.emit({ kind: 'status', content: `第 ${this.iterations}/${maxIterations} 轮：调用 LLM…` })
      let stream: AsyncGenerator<LlmStreamEvent>
      try {
        stream = await llm.callStream(this.context.toMessages(), tools.getToolSchemas(), abort.signal)
      } catch (e) {
        const msg = e instanceof AppError ? e.message : String(e)
        store.append({ type: 'system_message', timestamp: nowIso(), sessionId: this.sessionId, content: `LLM 调用失败: ${msg}` })
        return {
          success: false,
          message: `LLM 调用失败: ${msg}`,
          finished: false,
          iterations: this.iterations,
          usage: this.usage.snapshot(),
        }
      }

      // 3. 消费流式事件
      let finalText = ''
      const pendingToolCalls: ToolCall[] = []
      let streamError: string | undefined

      try {
        for await (const event of stream) {
          switch (event.kind) {
            case 'chunk':
              finalText += event.content
              this.emit({ kind: 'assistantStreamDelta', content: event.content })
              break
            case 'reasoning':
              this.emit({ kind: 'reasoningDelta', content: event.content })
              break
            case 'toolCallDelta':
              mergeToolCallDelta(pendingToolCalls, event.index, event.call)
              break
            case 'usage':
              this.usage.add(event.usage)
              this.emit({ kind: 'tokenUsage', usage: event.usage })
              break
            case 'done':
              break
          }
        }
      } catch (e) {
        streamError = e instanceof Error ? e.message : String(e)
      }

      if (streamError) {
        const msg = `LLM 流中断: ${streamError}`
        store.append({ type: 'system_message', timestamp: nowIso(), sessionId: this.sessionId, content: msg })
        return {
          success: false,
          message: msg,
          finished: false,
          iterations: this.iterations,
          usage: this.usage.snapshot(),
        }
      }

      // 4. 有工具调用 → 执行
      if (pendingToolCalls.length > 0) {
        this.context.appendAssistant(finalText, pendingToolCalls)
        if (finalText) {
          store.append({ type: 'assistant_message', timestamp: nowIso(), sessionId: this.sessionId, content: finalText })
        }

        for (const call of pendingToolCalls) {
          const name = call.function.name

          // 工具执行前 hook
          if (hooks?.isEnabled()) {
            await hooks.fire('pre-tool', {
              cwd: this.opts.workingDir,
              sessionId: this.sessionId,
              tool: name,
              args: call.function.arguments,
            })
          }

          // 安全评估 + 审批
          const registered = tools.get(name)
          let security: SecurityEvaluation | undefined
          if (registered && !registered.spec.skipSecurity) {
            security = evaluateForAgent(registered.spec, parseArgsSafe(call.function.arguments))
          }

          store.append({
            type: 'tool_call_request',
            timestamp: nowIso(),
            sessionId: this.sessionId,
            toolCallId: call.id,
            name,
            arguments: parseArgsSafe(call.function.arguments),
          })
          this.emit({ kind: 'toolCall', call, security })

          // 审批回调（注入 registry）
          const approvalFn =
            security?.approvalRequirement && security.approvalRequirement.requiresUserConfirmation
              ? async (ev: SecurityEvaluation): Promise<boolean> => {
                  const spec = registered?.spec
                  if (!spec) return true
                  const parsed = parseArgsSafe(call.function.arguments)
                  const scope = approvalScopeKey(spec, parsed)
                  const requirement =
                    ev.approvalRequirement ?? {
                      approvalType: 'one-time' as const,
                      dangerThreshold: ev.dangerLevel,
                      requiresUserConfirmation: true,
                      validitySeconds: 0,
                      scope: 'none' as const,
                    }
                  return approval.check(requirement, scope)
                }
              : undefined

          const result = await tools.execute(name, call.function.arguments, toolContext, approvalFn)

          store.append({
            type: 'tool_result',
            timestamp: nowIso(),
            sessionId: this.sessionId,
            toolCallId: call.id,
            name,
            success: result.success,
            content: truncateForStore(result.content),
          })
          this.emit({ kind: 'toolResult', callId: call.id, name, result })

          // 工具执行后 hook
          if (hooks?.isEnabled()) {
            await hooks.fire('post-tool', {
              cwd: this.opts.workingDir,
              sessionId: this.sessionId,
              tool: name,
              args: call.function.arguments,
              result: truncateForStore(result.content),
            })
          }

          this.context.appendToolResult(call.id, truncateForContext(result.content))

          // restart 请求
          if (result.restartRequested) {
            return this.handleRestart(result.content, abort)
          }

          // finish 结构化终止
          if (isFinishCall(name) && result.success) {
            const finishStatus = parseArgsSafe(call.function.arguments).status as string | undefined
            this.emit({ kind: 'status', content: `任务结束（${finishStatus ?? 'success'}）` })
            // agent-done hook
            if (hooks?.isEnabled()) {
              await hooks.fire('agent-done', { cwd: this.opts.workingDir, sessionId: this.sessionId })
            }
            store.flush()
            return {
              success: finishStatus !== 'failed',
              message: extractFinishMessage(call.function.arguments) ?? result.content,
              finished: true,
              finishStatus: finishStatus ?? 'success',
              iterations: this.iterations,
              usage: this.usage.snapshot(),
            }
          }
        }

        // 继续下一轮迭代
        continue
      }

      // 5. 无工具调用 → 最终回复
      this.context.appendAssistant(finalText)
      store.append({ type: 'assistant_message', timestamp: nowIso(), sessionId: this.sessionId, content: finalText })

      // agent-done hook
      if (hooks?.isEnabled()) {
        await hooks.fire('agent-done', { cwd: this.opts.workingDir, sessionId: this.sessionId })
      }
      store.flush()

      return {
        success: true,
        message: finalText,
        finished: false,
        iterations: this.iterations,
        usage: this.usage.snapshot(),
      }
    }

    // 达到最大迭代
    const msg = `达到最大迭代次数（${maxIterations}），任务未完成`
    store.append({ type: 'system_message', timestamp: nowIso(), sessionId: this.sessionId, content: msg })
    store.flush()
    return {
      success: false,
      message: msg,
      finished: false,
      iterations: this.iterations,
      usage: this.usage.snapshot(),
    }
  }

  /** restart：重置上下文（保留持久化），继续后续交互 */
  private handleRestart(reason: string, _abort: AbortController): AgentResult {
    log.warn(`Agent 重启: ${reason}`)
    this.context.reset(this.opts.systemPrompt)
    const { sessionStore } = this.opts
    sessionStore.append({
      type: 'system_message',
      timestamp: nowIso(),
      sessionId: this.sessionId,
      content: `会话重启: ${reason}`,
    })
    this.emit({ kind: 'status', content: `会话已重启: ${reason}` })
    return {
      success: true,
      message: `会话已重启（${reason}）`,
      finished: true,
      finishStatus: 'restart',
      iterations: this.iterations,
      usage: this.usage.snapshot(),
    }
  }

  private getCache(): ReadCache {
    return (this as unknown as { __cache?: ReadCache }).__cache ?? new ReadCache()
  }

  /** 供 App/registry 注入共享 ReadCache */
  setCache(cache: ReadCache): void {
    ;(this as unknown as { __cache: ReadCache }).__cache = cache
  }

  /** 设置流式事件回调（App/UI 注入） */
  setOnEvent(cb: (event: AgentEvent) => void): void {
    this.opts.onEvent = cb
  }

  private emit(event: AgentEvent): void {
    this.opts.onEvent?.(event)
  }
}

/** 按 index 合并工具调用增量（累积式：同一 index 的后续 delta 覆盖前面的字段） */
function mergeToolCallDelta(calls: ToolCall[], index: number, call: ToolCall): void {
  const existing = calls[index]
  if (!existing) {
    calls[index] = call
    return
  }
  // 累积合并：id/name/arguments 以"非空优先 + 更长者胜"
  existing.id = existing.id || call.id
  if (call.function.name.length > existing.function.name.length) {
    existing.function.name = call.function.name
  }
  if (call.function.arguments.length > existing.function.arguments.length) {
    existing.function.arguments = call.function.arguments
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function parseArgsSafe(json: string): Record<string, unknown> {
  if (!json || !json.trim()) return {}
  try {
    const parsed = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function extractFinishMessage(argsJson: string): string | undefined {
  const args = parseArgsSafe(argsJson)
  return typeof args.message === 'string' ? args.message : undefined
}

/** 持久化时截断工具结果（防止 JSONL 膨胀） */
function truncateForStore(content: string): string {
  return content.length > 50_000 ? `${content.slice(0, 50_000)}\n…（持久化截断）` : content
}

/** 回注上下文时截断（比持久化更严格，控制 token） */
function truncateForContext(content: string): string {
  return content.length > 20_000 ? `${content.slice(0, 20_000)}\n…（输出过长已截断，可用 read_file offset 查看剩余部分）` : content
}
