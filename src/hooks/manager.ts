import { log } from '../utils/logger.js'
import { runShell } from './shell.js'
import type { HookDefinition, HookEvent, HookResult } from './types.js'

/**
 * HookManager：按事件触发已注册的 hook。
 * - 加载 .dev-assistant-hooks.toml 定义
 * - fire(event, ctx) 并发执行所有匹配 hook（pre/post-tool 按 tool 名过滤）
 * - 单个 hook 失败不阻塞其他 hook 与主流程（仅记录日志）
 * - --no-hooks 时整体禁用
 */
export class HookManager {
  private hooks: HookDefinition[] = []
  private disabled = false
  private dryRun = false

  setHooks(hooks: HookDefinition[]): void {
    this.hooks = hooks
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled
  }

  /** --hooks-dry-run：只打印命令不执行 */
  setDryRun(dry: boolean): void {
    this.dryRun = dry
  }

  list(): HookDefinition[] {
    return [...this.hooks]
  }

  isEnabled(): boolean {
    return !this.disabled
  }

  private buildEnv(event: HookEvent, ctx: HookFireContext): Record<string, string> {
    const env: Record<string, string> = {
      DEV_ASSISTANT_EVENT: event,
      DEV_ASSISTANT_CWD: ctx.cwd,
    }
    if (ctx.sessionId) env.DEV_ASSISTANT_SESSION = ctx.sessionId
    if (ctx.tool) env.DEV_ASSISTANT_TOOL = ctx.tool
    if (ctx.args) env.DEV_ASSISTANT_ARGS = ctx.args
    if (ctx.result) env.DEV_ASSISTANT_RESULT = ctx.result
    return env
  }

  /**
   * 触发某事件的所有匹配 hook。
   * @returns 执行结果列表（disabled 时为空）
   */
  async fire(event: HookEvent, ctx: HookFireContext): Promise<HookResult[]> {
    if (this.disabled) return []
    const matched = this.hooks.filter((h) => {
      if (h.event !== event) return false
      if ((event === 'pre-tool' || event === 'post-tool') && h.tool && h.tool !== ctx.tool) return false
      return true
    })
    if (matched.length === 0) return []

    log.debug('触发 hooks', { event, count: matched.length, tool: ctx.tool ?? undefined })
    const env = this.buildEnv(event, ctx)

    return Promise.all(
      matched.map(async (h) => {
        if (this.dryRun) {
          log.info(`[dry-run] hook ${h.name}: ${h.command}`)
          return {
            name: h.name,
            success: true,
            stdout: `[dry-run] ${h.command}`,
            stderr: '',
            durationMs: 0,
            timedOut: false,
          }
        }
        try {
          const r = await runShell({
            command: h.command,
            cwd: ctx.cwd,
            env,
            timeoutMs: (h.timeoutSecs ?? 30) * 1000,
          })
          const result: HookResult = {
            name: h.name,
            success: r.success,
            stdout: r.stdout,
            stderr: r.stderr,
            durationMs: r.durationMs,
            timedOut: r.timedOut,
          }
          if (!r.success) {
            log.warn(`hook ${h.name} 执行失败 (exit=${r.exitCode}${r.timedOut ? ', 超时' : ''})`, {
              stderr: r.stderr.slice(0, 200),
            })
          }
          return result
        } catch (e) {
          log.error(`hook ${h.name} 启动失败: ${e instanceof Error ? e.message : String(e)}`)
          return {
            name: h.name,
            success: false,
            stdout: '',
            stderr: e instanceof Error ? e.message : String(e),
            durationMs: 0,
            timedOut: false,
          }
        }
      }),
    )
  }

  /** 收集注入用输出（injectOutput=true 的 hook 的 stdout） */
  static collectInjection(results: HookResult[], definitions: HookDefinition[]): string[] {
    const injectNames = new Set(definitions.filter((d) => d.injectOutput).map((d) => d.name))
    return results
      .filter((r) => r.success && injectNames.has(r.name) && r.stdout.trim().length > 0)
      .map((r) => `[hook:${r.name}] ${r.stdout.trim()}`)
  }
}

export interface HookFireContext {
  cwd: string
  sessionId?: string
  tool?: string
  args?: string
  result?: string
}
