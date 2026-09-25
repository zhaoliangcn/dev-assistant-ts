import { AppError, isAppError } from '../utils/error.js'
import { sleep } from '../utils/sleep.js'
import { log } from '../utils/logger.js'

/**
 * 重试与退避策略（对齐 Rust 版 `src/llm/retry.rs`）。
 *
 * 三类错误：
 * - transient: HTTP 429 / 5xx → 最多 5 次，指数退避 2s 起，封顶 120s，带 25% 抖动，尊重 Retry-After
 * - network:   连接层错误（DNS/连接拒绝/连接超时）→ 最多 2 次，500ms 起，封顶 5s
 * - fatal:     其他（4xx 等）→ 不重试，直接抛出
 */

export type RetryClass = 'transient' | 'network' | 'fatal'

export const MAX_RETRIES = 5
export const BASE_DELAY_MS = 2000
export const BACKOFF_MULTIPLIER = 2.0
export const MAX_DELAY = 120_000

export const NETWORK_MAX_RETRIES = 2
export const NETWORK_BASE_DELAY_MS = 500
export const NETWORK_MAX_DELAY = 5000

/** 错误分类 */
export function classifyError(error: AppError): RetryClass {
  if (error.isRateLimited() || error.isServerError()) return 'transient'
  if (error.isConnectError()) return 'network'
  return 'fatal'
}

/** 计算退避延迟（毫秒）。attempt 从 1 开始。 */
export function computeDelay(
  retryClass: RetryClass,
  error: AppError,
  attempt: number,
): number {
  if (retryClass === 'transient') {
    const retryAfter = error.retryAfter()
    if (retryAfter !== null && retryAfter <= MAX_DELAY) return retryAfter
    const base = BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1)
    const jitterRange = Math.floor(base * 0.25)
    const jitter = Math.floor(Math.random() * (jitterRange + 1))
    return Math.min(base + jitter, MAX_DELAY)
  }
  if (retryClass === 'network') {
    const base = NETWORK_BASE_DELAY_MS * Math.pow(2, attempt - 1)
    return Math.min(base, NETWORK_MAX_DELAY)
  }
  return 0
}

export interface RetryOptions {
  /** 退避延迟实现（测试可注入固定值） */
  delayFn?: (ms: number) => Promise<void>
  /** 每次重试前的回调 */
  onRetry?: (attempt: number, error: AppError, retryClass: RetryClass, delayMs: number) => void
}

/**
 * 带退避的重试执行器。
 * @param fn 待执行操作
 * @param opts 重试选项
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const delayFn = opts.delayFn ?? sleep
  let attempt = 0
  for (;;) {
    attempt++
    try {
      return await fn()
    } catch (e) {
      const err = normalizeError(e)
      const retryClass = classifyError(err)
      const maxRetries = retryClass === 'transient' ? MAX_RETRIES : retryClass === 'network' ? NETWORK_MAX_RETRIES : 0
      if (attempt > maxRetries) throw err
      const delayMs = computeDelay(retryClass, err, attempt)
      if (delayMs > 0) {
        log.debug('LLM 重试退避', { attempt, retryClass, delayMs, message: err.message })
        opts.onRetry?.(attempt, err, retryClass, delayMs)
        await delayFn(delayMs)
      }
    }
  }
}

/** 把 unknown 错误归一为 AppError */
function normalizeError(e: unknown): AppError {
  if (isAppError(e)) return e
  if (e instanceof Error) {
    // 网络层常见错误标记
    const msg = e.message.toLowerCase()
    const isNet =
      e instanceof TypeError && (msg.includes('fetch') || msg.includes('network') || msg.includes('socket')) ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('etimedout') ||
      msg.includes('econnreset') ||
      msg.includes('connect etimedout') ||
      msg.includes('other side closed')
    if (isNet) {
      return AppError.Llm(`网络错误: ${e.message}`, { connect: true })
    }
    return AppError.Llm(`LLM 调用错误: ${e.message}`)
  }
  return AppError.Llm(`LLM 调用错误: ${String(e)}`)
}
