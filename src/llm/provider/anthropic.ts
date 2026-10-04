import type {
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  LlmMessage,
  ToolCall,
  TokenUsage,
} from '../models.js'
import { AppError } from '../../utils/error.js'
import { httpError, readBodyText, sseDataLines, toConnectError } from './common.js'
import { joinUrl } from './openai.js'
import type { LlmProvider, HttpClientLike, HttpResponse } from './types.js'

/**
 * Anthropic Messages API（/v1/messages）。
 * 协议差异：
 * - 系统提示词走 `system` 字段（不在 messages 数组）
 * - 工具定义放 `tools`，结果消息为 `{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }`
 * - 流式事件类型：message_start / content_block_start / content_block_delta / message_delta / message_stop / error
 */
export class AnthropicProvider implements LlmProvider {
  readonly name: string
  readonly type = 'anthropic' as const
  private readonly apiUrl: string
  private readonly apiKey: string
  private readonly maxOutputTokens?: number

  constructor(opts: { name: string; apiUrl: string; apiKey?: string; maxOutputTokens?: number }) {
    this.name = opts.name
    this.apiUrl = opts.apiUrl
    this.apiKey = opts.apiKey ?? ''
    this.maxOutputTokens = opts.maxOutputTokens
  }

  private endpoint(): string {
    return joinUrl(this.apiUrl, 'messages')
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    }
  }

  private buildBody(request: LlmRequest, stream: boolean): Record<string, unknown> {
    // system 消息提到顶层字段
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content ?? '')
      .filter((s) => s.length > 0)
      .join('\n\n')

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: this.maxOutputTokens ?? request.maxOutputTokens ?? 8192,
      temperature: request.temperature,
      messages: toAnthropicMessages(request.messages),
      stream,
    }
    if (system) body.system = system
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }))
    }
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
    const body = await readBodyText(res.body)
    if (res.status >= 400) throw httpError(res.status, body, res.headers)

    let obj: any
    try {
      obj = JSON.parse(body)
    } catch {
      throw AppError.Llm(`LLM 响应不是有效 JSON: ${body.slice(0, 200)}`)
    }

    const usage: TokenUsage | undefined =
      typeof obj.usage?.input_tokens === 'number'
        ? {
            promptTokens: obj.usage.input_tokens,
            completionTokens: typeof obj.usage.output_tokens === 'number' ? obj.usage.output_tokens : 0,
            totalTokens:
              (typeof obj.usage.input_tokens === 'number' ? obj.usage.input_tokens : 0) +
              (typeof obj.usage.output_tokens === 'number' ? obj.usage.output_tokens : 0),
          }
        : undefined

    const blocks: any[] = Array.isArray(obj.content) ? obj.content : []
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
    const calls: ToolCall[] = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b, i) => ({
        id: String(b.id ?? `toolu_${i}`),
        function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) },
      }))

    if (calls.length > 0) return { kind: 'toolCalls', calls, usage, content: text || undefined }
    return { kind: 'text', content: text, usage }
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
      const errBody = await readBodyText(res.body).catch(() => '')
      throw httpError(res.status, errBody, res.headers)
    }

    // content_block 累积：text / thinking / tool_use
    let inputTokens = 0
    let outputTokens = 0
    interface Block {
      type: string
      text?: string
      id?: string
      name?: string
      args: string
    }
    const blocks: Block[] = []
    const toolCallIds: string[] = []
    /** 已通过 input_json_delta 发过增量的块（块结束时判断是否需要补发完整调用） */
    const deltaEmitted: boolean[] = []

    try {
      for await (const line of sseDataLines(res.body, signal)) {
        let obj: any
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        const etype: string = obj.type ?? ''

        if (etype === 'message_start') {
          inputTokens = obj.message?.usage?.input_tokens ?? 0
        } else if (etype === 'content_block_start') {
          const idx: number = obj.index ?? 0
          const cb = obj.content_block ?? {}
          blocks[idx] = {
            type: cb.type ?? 'text',
            text: cb.type === 'text' ? cb.text ?? '' : undefined,
            id: cb.id,
            name: cb.name,
            args: cb.type === 'tool_use' ? seedToolArgs(cb.input) : '',
          }
          if (cb.type === 'tool_use' && cb.id) toolCallIds[idx] = cb.id
        } else if (etype === 'content_block_delta') {
          const idx: number = obj.index ?? 0
          const block = blocks[idx]
          const d = obj.delta ?? {}
          if (!block) continue
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            block.text = (block.text ?? '') + d.text
            if (d.text.length > 0) yield { kind: 'chunk', content: d.text }
          } else if (
            (d.type === 'thinking_delta' || d.type === 'signature_delta') &&
            typeof d.thinking === 'string'
          ) {
            yield { kind: 'reasoning', content: d.thinking }
          } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            block.args += d.partial_json
            deltaEmitted[idx] = true
            yield {
              kind: 'toolCallDelta',
              index: idx,
              call: {
                id: toolCallIds[idx] ?? '',
                function: { name: block.name ?? '', arguments: block.args },
              },
            }
          }
        } else if (etype === 'content_block_stop') {
          // 兜底：部分网关在 content_block_start 直接下发完整 input 且无任何增量，
          // 不补发的话该 tool_use 会被整块丢弃
          const idx: number = obj.index ?? 0
          const block = blocks[idx]
          if (block?.type === 'tool_use' && !deltaEmitted[idx]) {
            deltaEmitted[idx] = true
            yield {
              kind: 'toolCallDelta',
              index: idx,
              call: {
                id: toolCallIds[idx] ?? '',
                function: { name: block.name ?? '', arguments: block.args },
              },
            }
          }
        } else if (etype === 'message_delta') {
          outputTokens = obj.usage?.output_tokens ?? outputTokens
        } else if (etype === 'error') {
          throw AppError.Llm(`Anthropic 流错误: ${obj.error?.message ?? 'unknown'}`)
        }
      }
    } catch (e) {
      if (signal?.aborted) {
        yield { kind: 'done' }
        return
      }
      throw e
    }

    const usageTotal: TokenUsage = {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    }
    yield { kind: 'usage', usage: usageTotal }
    yield { kind: 'done' }
  }
}

/** 统一 LlmMessage[] → Anthropic messages（system 已剥离） */
function toAnthropicMessages(messages: LlmMessage[]): unknown[] {
  const out: unknown[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      // tool 结果：{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }
      const prev = out[out.length - 1] as { role?: string; content?: unknown } | undefined
      if (prev && prev.role === 'user' && Array.isArray(prev.content) && prev.content.some((b: any) => b?.type === 'tool_result')) {
        prev.content.push({ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content ?? '' })
      } else {
        out.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content ?? '' }],
        })
      }
      continue
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const content: any[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const c of m.toolCalls) {
        content.push({ type: 'tool_use', id: c.id, name: c.function.name, input: safeJson(c.function.arguments) })
      }
      out.push({ role: 'assistant', content })
      continue
    }
    out.push({ role: m.role, content: m.content ?? '' })
  }
  return out
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

/**
 * tool_use 块的参数初值。
 * Anthropic 流式协议里 `content_block_start.content_block.input` 恒为空对象 `{}`，
 * 真正的参数通过后续 `input_json_delta.partial_json` 增量下发。
 * 若把 `{}` 序列化做初值，会与增量拼接成 `{}{"a":1}` 这类非法 JSON，因此仅在非空时采用。
 */
function seedToolArgs(input: unknown): string {
  if (input && typeof input === 'object' && Object.keys(input).length > 0) return JSON.stringify(input)
  return ''
}
