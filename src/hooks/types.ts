/**
 * Hook 类型（对齐 Rust 版 `src/hooks/types.rs`）。
 *
 * Hook 是用户定义的 shell 脚本，在特定事件触发时执行。
 * 事件类型：
 * - session-start  会话开始时
 * - pre-tool       工具执行前
 * - post-tool      工具执行后
 * - agent-done     Agent 一轮完成后
 */

export type HookEvent = 'session-start' | 'pre-tool' | 'post-tool' | 'agent-done'

/** hook 定义（.dev-assistant-hooks.toml 中的 [[hooks]] 条目） */
export interface HookDefinition {
  /** 唯一名称 */
  name: string
  /** 触发事件 */
  event: HookEvent
  /** 要执行的 shell 命令 */
  command: string
  /** 仅当工具名匹配时触发（pre-tool/post-tool 用） */
  tool?: string
  /** 超时（秒），默认 30 */
  timeoutSecs?: number
  /** 输出注入上下文（true 时 hook stdout 会作为 system message 注入） */
  injectOutput?: boolean
}

/** hook 执行结果 */
export interface HookResult {
  name: string
  success: boolean
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

/** 传给 hook 脚本的环境变量 */
export interface HookEnv {
  /** 事件类型 */
  DEV_ASSISTANT_EVENT: string
  /** 工具名（pre/post-tool） */
  DEV_ASSISTANT_TOOL?: string
  /** 工具参数 JSON（pre/post-tool） */
  DEV_ASSISTANT_ARGS?: string
  /** 工具结果（post-tool） */
  DEV_ASSISTANT_RESULT?: string
  /** 工作目录 */
  DEV_ASSISTANT_CWD: string
  /** 会话 id */
  DEV_ASSISTANT_SESSION?: string
}
