import { AppError as AE } from '../../utils/error.js'

/**
 * Provider 层共享的 HTTP 错误分类 + SSE 解析纯函数。
 * 不 import undici，保持 provider 层可独立单测。
 */

// ---------------------------------------------------------------------------
// HTTP 响应错误分类
// ---------------------------------------------------------------------------

/**
 * 将 HTTP 错误状态码 + body 转为 AppError。
 * - 429 / 5xx 可重试；4xx 致命；连接层错误（connect=true）走快速重试。
 */
export function httpError(status: number, body: string, headers?: Record<string, string | string[]>): AE {
  const retryAfterMs = parseRetryAfter(headers?.['retry-after']) ?? undefined
  const summary = body.length > 300 ? `${body.slice(0, 300)}…` : body
  const msg = `LLM API 错误 (HTTP ${status})${summary ? `: ${summary}` : ''}`
  return AE.Llm(msg, { status, retryAfterMs, detail: body || undefined })
}

/** 读取 Web ReadableStream 全文（provider 层消费错误 body 用） */
export async function readBodyText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  const parts: string[] = []
  for (;;) {
    const chunk = await reader.read().catch((e) => {
      // 连接中断：返回已读部分，由调用方按状态码判断
      if (parts.length === 0) throw e
      return { done: true as const, value: undefined }
    })
    if (chunk.done) break
    if (chunk.value) parts.push(decoder.decode(chunk.value, { stream: true }))
  }
  parts.push(decoder.decode())
  return parts.join('')
}

/** 解析 Retry-After 头（秒 或 HTTP 日期）为毫秒；无有效值返回 null */
export function parseRetryAfter(value: string | string[] | undefined): number | null {
  if (value === undefined) return null
  const s = Array.isArray(value) ? value[0] : value
  if (!s) return null
  const secs = Number(s)
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000)
  const date = Date.parse(s)
  if (!Number.isNaN(date)) {
    const delta = date - Date.now()
    return delta > 0 ? Math.round(delta) : 0
  }
  return null
}

// ---------------------------------------------------------------------------
// SSE 行读取
// ---------------------------------------------------------------------------

/**
 * 从 ReadableStream 中逐行读取 SSE `data:` 字段值。
 * 处理：
 * - 跨 chunk 的不完整行（buffer 拼接）
 * - `data: [DONE]` 终止（以生成器结束为准）
 * - 空行（事件分隔）/ 注释行 `:`
 * - CRLF 行尾
 *
 * @param body 响应 body（Web ReadableStream）
 * @param signal 取消信号
 */
export async function* sseDataLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  const onAbort = () => {
    reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (e) {
        throw toConnectError(e)
      }
      if (chunk.done) {
        const leftover = buffer.trim()
        if (leftover) {
          const data = extractData(leftover)
          if (data !== null) yield data
        }
        return
      }
      buffer += decoder.decode(chunk.value, { stream: true })

      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        const data = extractData(line)
        if (data !== null) yield data
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

/** 提取一行 SSE 的 data 字段；非 data 行 / [DONE] 返回 null */
function extractData(line: string): string | null {
  const t = line.trim()
  if (t === '' || t.startsWith(':')) return null
  if (!t.startsWith('data:')) return null
  const value = t.slice(5).trimStart()
  if (value === '[DONE]') return null
  return value
}

/** 将底层读错误归类：连接/网络错误 → AppError(connect=true) */
export function toConnectError(e: unknown): AE {
  if (e instanceof AE) return e
  const msg = e instanceof Error ? e.message : String(e)
  return AE.Llm(`连接中断: ${msg}`, { connect: true })
}

// ---------------------------------------------------------------------------
// OpenAI 兼容 SSE 解析（纯函数）
// ---------------------------------------------------------------------------

export interface OpenAiDelta {
  text: string
  reasoning: string
  /** 按 index 累积的 tool calls（稀疏数组） */
  toolCalls: OpenAiAccumulatedCall[]
  usage?: { prompt: number; completion: number; total: number }
}

export interface OpenAiAccumulatedCall {
  id: string
  name: string
  /** JSON 字符串（逐步累积） */
  arguments: string
}

/**
 * 解析一条 OpenAI 兼容 SSE data 行（choices[0].delta 形式），产出增量。
 * 纯函数，便于单测。
 *
 * 支持字段：
 * - delta.content → 文本增量
 * - delta.reasoning_content / delta.reasoning / delta.thinking → 思考增量
 * - delta.tool_calls[].{index,id,function:{name,arguments}} → 工具调用累积
 * - usage（prompt_tokens/completion_tokens/total_tokens）→ 用量
 * - 非流式整包：choices[0].message（含 message.tool_calls）
 */
export function parseOpenAiSseLine(line: string): OpenAiDelta | null {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>

  const out: OpenAiDelta = { text: '', reasoning: '', toolCalls: [] }
  let touched = false

  const choices = o.choices
  if (Array.isArray(choices)) {
    for (const rawChoice of choices) {
      if (typeof rawChoice !== 'object' || rawChoice === null) continue
      const choice = rawChoice as Record<string, unknown>
      const delta = choice.delta as Record<string, unknown> | undefined
      const message = choice.message as Record<string, unknown> | undefined

      if (delta) {
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          out.text += delta.content
          touched = true
        }
        const reasoning =
          (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
          (typeof delta.reasoning === 'string' && delta.reasoning) ||
          (typeof delta.thinking === 'string' && delta.thinking)
        if (reasoning) {
          out.reasoning += reasoning
          touched = true
        }

        const calls = delta.tool_calls
        if (Array.isArray(calls)) {
          for (const rawC of calls) {
            if (typeof rawC !== 'object' || rawC === null) continue
            const c = rawC as Record<string, unknown>
            const idx = typeof c.index === 'number' ? c.index : out.toolCalls.length
            const fn = c.function as Record<string, unknown> | undefined
            let acc = out.toolCalls[idx]
            if (!acc) {
              acc = { id: '', name: '', arguments: '' }
              out.toolCalls[idx] = acc
            }
            if (typeof c.id === 'string') acc.id = c.id
            if (typeof fn?.name === 'string') acc.name += fn.name
            if (typeof fn?.arguments === 'string') acc.arguments += fn.arguments
            touched = true
          }
        }
      }

      // 非流式 message.tool_calls 一次性下发
      const messageCalls = message?.tool_calls
      if (Array.isArray(messageCalls)) {
        touched = true
        for (const rawC of messageCalls) {
          if (typeof rawC !== 'object' || rawC === null) continue
          const c = rawC as Record<string, unknown>
          const fn = c.function as Record<string, unknown> | undefined
          out.toolCalls.push({
            id: typeof c.id === 'string' ? c.id : '',
            name: typeof fn?.name === 'string' ? fn.name : '',
            arguments: typeof fn?.arguments === 'string' ? fn.arguments : '',
          })
        }
      }
    }
  }

  const usage = o.usage
  if (usage && typeof usage === 'object') {
    const u = usage as Record<string, unknown>
    if (typeof u.prompt_tokens === 'number') {
      out.usage = {
        prompt: u.prompt_tokens,
        completion: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
        total: typeof u.total_tokens === 'number' ? u.total_tokens : 0,
      }
      touched = true
    }
  }

  return touched ? out : null
}
