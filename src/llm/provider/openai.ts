import type {
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  LlmMessage,
  ToolCall,
  TokenUsage,
} from '../models.js'
import { AppError } from '../../utils/error.js'
import { httpError, readBodyText, sseDataLines, parseOpenAiSseLine, toConnectError } from './common.js'
import type { LlmProvider, HttpClientLike, HttpResponse } from './types.js'

/** URL 拼接：去除 base 尾部斜杠后追加 path */
export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}

/** 把统一 LlmMessage[] 转成 OpenAI 协议 messages */
export function toOpenAiMessages(messages: LlmMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content ?? '' }
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.function.name, arguments: c.function.arguments },
        })),
      }
    }
    return { role: m.role, content: m.content ?? '' }
  })
}

/** OpenAI 兼容协议的共享实现（OpenAI / OpenAI-compatible / Ollama 均基于此） */
export class OpenAIBase implements LlmProvider {
  readonly name: string
  type: 'openai' | 'openai-compatible' | 'ollama'
  private readonly apiUrl: string
  private readonly apiKey: string
  private readonly maxOutputTokens?: number
  private readonly reasoningEffort?: string

  constructor(opts: {
    name: string
    type: 'openai' | 'openai-compatible' | 'ollama'
    apiUrl: string
    apiKey?: string
    maxOutputTokens?: number
    reasoningEffort?: string
  }) {
    this.name = opts.name
    this.type = opts.type
    this.apiUrl = opts.apiUrl
    this.apiKey = opts.apiKey ?? ''
    this.maxOutputTokens = opts.maxOutputTokens
    this.reasoningEffort = opts.reasoningEffort
  }

  /** 切换 provider 类型标记（openai-compatible 复用本实现） */
  withType(type: 'openai' | 'openai-compatible' | 'ollama'): this {
    this.type = type
    return this
  }

  protected endpoint(): string {
    return joinUrl(this.apiUrl, 'chat/completions')
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    }
  }

  private buildBody(request: LlmRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAiMessages(request.messages),
      temperature: request.temperature,
      stream,
    }
    const maxTokens = this.maxOutputTokens ?? request.maxOutputTokens
    if (maxTokens !== undefined) body.max_tokens = maxTokens
    if (request.tools && request.tools.length > 0) body.tools = request.tools
    const effort = this.reasoningEffort ?? request.reasoningEffort
    if (effort) body.reasoning_effort = effort
    if (stream) body.stream_options = { include_usage: true }
    return body
  }

  async chat(http: HttpClientLike, request: LlmRequest): Promise<LlmResponse> {
    let res: HttpResponse
    try {
      res = await http.request(this.endpoint(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.buildBody(request, false)),
      })
    } catch (e) {
      throw toConnectError(e)
    }
    const text = await readBodyText(res.body)
    if (res.status >= 400) throw httpError(res.status, text, res.headers)

    let obj: any
    try {
      obj = JSON.parse(text)
    } catch {
      throw AppError.Llm(`LLM 响应不是有效 JSON: ${text.slice(0, 200)}`)
    }

    const usage = mapUsage(obj.usage)
    const message = obj.choices?.[0]?.message
    if (message?.tool_calls?.length) {
      const calls: ToolCall[] = message.tool_calls.map((c: any) => ({
        id: String(c.id ?? `call_${Math.random().toString(36).slice(2, 10)}`),
        function: {
          name: String(c.function?.name ?? ''),
          arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}),
        },
      }))
      return { kind: 'toolCalls', calls, usage, content: message.content ?? undefined }
    }
    return { kind: 'text', content: message?.content ?? '', usage }
  }

  async *chatStream(http: HttpClientLike, request: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmStreamEvent> {
    let res: HttpResponse
    try {
      res = await http.request(this.endpoint(), {
        method: 'POST',
        headers: { ...this.headers(), accept: 'text/event-stream' },
        body: JSON.stringify(this.buildBody(request, true)),
        signal,
      })
    } catch (e) {
      if (signal?.aborted) return
      throw toConnectError(e)
    }

    if (res.status >= 400) {
      const text = await readBodyText(res.body).catch(() => '')
      throw httpError(res.status, text, res.headers)
    }

    // 记录每个 index 已发出的 call 快照，仅在变化时重发。
    // 按契约每次 yield 的 call 携带该 index 当前已知的【完整】内容：
    // 标准OpenAI 协议的 delta 是分片（需累积），部分网关直接发完整快照（需覆盖），
    // mergeArgs 以「快照前缀命中则覆盖，否则拼接」同时兼容两种形态。
    const accByIdx: Array<{ id: string; name: string; args: string }> = []
    const emitted: Array<{ id: string; name: string; arguments: string }> = []
    let usage: TokenUsage | undefined

    try {
      for await (const line of sseDataLines(res.body, signal)) {
        const delta = parseOpenAiSseLine(line)
        if (!delta) continue
        if (delta.text) yield { kind: 'chunk', content: delta.text }
        if (delta.reasoning) yield { kind: 'reasoning', content: delta.reasoning }
        if (delta.usage) {
          usage = {
            promptTokens: delta.usage.prompt,
            completionTokens: delta.usage.completion,
            totalTokens: delta.usage.total,
          }
        }

        for (let i = 0; i < delta.toolCalls.length; i++) {
          const c = delta.toolCalls[i]
          if (!c) continue
          const acc = accByIdx[i] ?? { id: '', name: '', args: '' }
          const next = {
            id: c.id || acc.id,
            name: mergeSnapshotField(acc.name, c.name),
            args: mergeSnapshotField(acc.args, c.arguments),
          }
          accByIdx[i] = next
          const prev = emitted[i]
          if (
            !prev ||
            prev.id !== next.id ||
            prev.name !== next.name ||
            prev.arguments !== next.args
          ) {
            emitted[i] = { id: next.id, name: next.name, arguments: next.args }
            yield {
              kind: 'toolCallDelta',
              index: i,
              call: {
                id: next.id,
                function: { name: next.name, arguments: next.args },
              },
            }
          }
        }
      }
    } catch (e) {
      if (signal?.aborted) {
        yield { kind: 'done' }
        return
      }
      throw toConnectError(e)
    }

    if (usage) yield { kind: 'usage', usage }
    yield { kind: 'done' }
  }
}

/**
 * 合并流式字段：incoming 是完整快照（以 acc 为前缀且更长）时覆盖；
 * incoming 是增量分片时拼接；旧值更长（重复回放）时保留旧值。
 */
function mergeSnapshotField(acc: string, incoming: string): string {
  if (!incoming) return acc
  if (!acc) return incoming
  if (incoming.length >= acc.length && incoming.startsWith(acc)) return incoming
  if (acc.length > incoming.length && acc.startsWith(incoming)) return acc
  return acc + incoming
}

export class OpenAIProvider extends OpenAIBase {
  constructor(opts: { name: string; apiUrl: string; apiKey?: string; maxOutputTokens?: number; reasoningEffort?: string }) {
    super({ ...opts, type: 'openai' })
  }
}

function mapUsage(u: any): TokenUsage | undefined {
  if (!u || typeof u.prompt_tokens !== 'number') return undefined
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
    totalTokens: typeof u.total_tokens === 'number' ? u.total_tokens : 0,
  }
}
