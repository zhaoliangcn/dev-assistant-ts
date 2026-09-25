/**
 * 统一错误类型。
 *
 * 分类（kind）：
 * - llm      LLM API 调用错误（可携带 HTTP status / Retry-After / 连接失败标记）
 * - config   配置错误
 * - io       文件 / IO 错误
 * - tool     工具执行错误
 * - approval 审批被拒绝
 * - subagent 子代理错误
 * - internal 内部错误
 */

export type AppErrorKind =
  | 'llm'
  | 'config'
  | 'io'
  | 'tool'
  | 'approval'
  | 'subagent'
  | 'internal'

export interface AppErrorOptions {
  /** HTTP 状态码（仅 LLM API 响应错误） */
  status?: number
  /** 连接层错误标记（DNS / 连接被拒 / 连接超时），用于重试分类 */
  connect?: boolean
  /** Retry-After 头（毫秒），provider 解析后传入 */
  retryAfterMs?: number
  /** 附加详情（原始错误消息等） */
  detail?: string
}

export class AppError extends Error {
  readonly kind: AppErrorKind
  readonly status?: number
  readonly connect?: boolean
  readonly retryAfterMs?: number
  readonly detail?: string

  constructor(kind: AppErrorKind, message: string, options: AppErrorOptions = {}) {
    super(message)
    this.name = 'AppError'
    this.kind = kind
    this.status = options.status
    this.connect = options.connect
    this.retryAfterMs = options.retryAfterMs
    this.detail = options.detail
  }

  /** 静态工厂：LLM 错误 */
  static Llm(message: string, options: AppErrorOptions = {}): AppError {
    return new AppError('llm', message, options)
  }

  /** 静态工厂：配置错误 */
  static Config(message: string): AppError {
    return new AppError('config', message)
  }

  /** 静态工厂：IO 错误 */
  static Io(message: string, detail?: string): AppError {
    return new AppError('io', message, { detail })
  }

  /** 静态工厂：工具执行错误 */
  static Tool(message: string, detail?: string): AppError {
    return new AppError('tool', message, { detail })
  }

  /** 静态工厂：子代理深度超限 */
  static SubagentDepthLimit(depth: number): AppError {
    return new AppError('subagent', `子代理深度超限（depth=${depth}，最大 3）`)
  }

  /** 静态工厂：内部错误 */
  static Internal(message: string, detail?: string): AppError {
    return new AppError('internal', message, { detail })
  }

  /** 是否限流（HTTP 429） */
  isRateLimited(): boolean {
    return this.status === 429
  }

  /** 是否服务端错误（HTTP 5xx） */
  isServerError(): boolean {
    return this.status !== undefined && this.status >= 500
  }

  /** 是否连接层错误（可快速重试） */
  isConnectError(): boolean {
    return this.connect === true
  }

  /** Retry-After（毫秒），无则返回 null */
  retryAfter(): number | null {
    return this.retryAfterMs ?? null
  }
}

/** 判断任意 unknown 错误是否为 AppError */
export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}
