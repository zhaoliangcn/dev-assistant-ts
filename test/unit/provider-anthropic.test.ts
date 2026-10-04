import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../../src/llm/provider/anthropic.js'
import { OllamaProvider } from '../../src/llm/provider/ollama.js'
import { OpenAIProvider, joinUrl, toOpenAiMessages } from '../../src/llm/provider/openai.js'
import { createProvider } from '../../src/llm/provider/factory.js'
import type { HttpClientLike, HttpResponse } from '../../src/llm/provider/types.js'
import type { LlmMessage, LlmRequest, LlmStreamEvent, ProviderConfig, ToolSchema } from '../../src/llm/models.js'
import { AppError } from '../../src/utils/error.js'

/**
 * Anthropic / Ollama provider 与工厂的纯单测：
 * 用假的 HttpClientLike 注入响应，不依赖网络，专门覆盖协议转换与流式事件解析。
 */

const API_URL = 'https://api.anthropic.test/v1/'
const ENDPOINT = 'https://api.anthropic.test/v1/messages'

function toStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

interface RecordedCall {
  url: string
  init: RequestInit
  /** 反序列化后的请求体 */
  json: Record<string, any>
}

/** 记录请求并返回预设响应的假 HTTP 客户端 */
class FakeHttp implements HttpClientLike {
  readonly calls: RecordedCall[] = []

  constructor(
    private readonly res: {
      status?: number
      headers?: Record<string, string | string[]>
      text?: string
      sse?: string[]
      throwOnRequest?: Error
    },
  ) {}

  async request(url: string, init: RequestInit): Promise<HttpResponse> {
    if (this.res.throwOnRequest) throw this.res.throwOnRequest
    this.calls.push({ url, init, json: JSON.parse(String(init.body)) as Record<string, any> })
    const body = this.res.sse ? toStream(this.res.sse) : toStream([this.res.text ?? ''])
    return { status: this.res.status ?? 200, headers: this.res.headers ?? {}, body }
  }

  get last(): RecordedCall {
    const c = this.calls[this.calls.length - 1]
    if (!c) throw new Error('没有任何请求被记录')
    return c
  }
}

function anthropic(opts: { maxOutputTokens?: number } = {}): AnthropicProvider {
  return new AnthropicProvider({ name: 'claude-x', apiUrl: API_URL, apiKey: 'sk-ant-test', ...opts })
}

function req(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return { model: 'claude-x', temperature: 0.3, messages: [{ role: 'user', content: 'hi' }], ...overrides }
}

/** SSE data 帧 */
function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

async function collect(gen: AsyncGenerator<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

const toolSchema: ToolSchema = {
  type: 'function',
  function: { name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
}

describe('AnthropicProvider 请求构造', () => {
  it('端点拼接、鉴权头与 anthropic-version', async () => {
    const http = new FakeHttp({ text: '{"content":[]}' })
    await anthropic().chat(http, req())
    expect(http.last.url).toBe(ENDPOINT)
    const headers = http.last.init.headers as Record<string, string>
    expect(http.last.init.method).toBe('POST')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(http.last.json.stream).toBe(false)
  })

  it('流式请求带 accept: text/event-stream 且 stream=true', async () => {
    const http = new FakeHttp({ sse: [sse({ type: 'message_stop' })] })
    await collect(anthropic().chatStream(http, req()))
    const headers = http.last.init.headers as Record<string, string>
    expect(headers.accept).toBe('text/event-stream')
    expect(http.last.json.stream).toBe(true)
  })

  it('system 消息提升为顶层字段并在多条时以空行连接', async () => {
    const http = new FakeHttp({ text: '{"content":[]}' })
    await anthropic().chat(
      http,
      req({
        messages: [
          { role: 'system', content: '规则一' },
          { role: 'system', content: '规则二' },
          { role: 'user', content: 'hi' },
        ],
      }),
    )
    expect(http.last.json.system).toBe('规则一\n\n规则二')
    expect(http.last.json.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('无 system 时不写 system 字段', async () => {
    const http = new FakeHttp({ text: '{"content":[]}' })
    await anthropic().chat(http, req())
    expect('system' in http.last.json).toBe(false)
  })

  it('max_tokens 优先级：provider > request > 8192', async () => {
    const cases: Array<[AnthropicProvider, LlmRequest, number]> = [
      [anthropic({ maxOutputTokens: 100 }), req({ maxOutputTokens: 7 }), 100],
      [anthropic(), req({ maxOutputTokens: 7 }), 7],
      [anthropic(), req(), 8192],
    ]
    for (const [p, r, expected] of cases) {
      const http = new FakeHttp({ text: '{"content":[]}' })
      await p.chat(http, r)
      expect(http.last.json.max_tokens).toBe(expected)
    }
  })

  it('tools 转为 name/description/input_schema；无 tools 时不写该字段', async () => {
    const withTools = new FakeHttp({ text: '{"content":[]}' })
    await anthropic().chat(withTools, req({ tools: [toolSchema] }))
    expect(withTools.last.json.tools).toEqual([
      { name: 'read_file', description: '读取文件', input_schema: toolSchema.function.parameters },
    ])

    const withoutTools = new FakeHttp({ text: '{"content":[]}' })
    await anthropic().chat(withoutTools, req({ tools: [] }))
    expect('tools' in withoutTools.last.json).toBe(false)
  })

  it('assistant 工具调用与 tool 结果转成 tool_use / tool_result 块', async () => {
    const http = new FakeHttp({ text: '{"content":[]}' })
    const messages: LlmMessage[] = [
      { role: 'user', content: '读两个文件' },
      {
        role: 'assistant',
        content: '好的',
        toolCalls: [
          { id: 'tu1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
          { id: 'tu2', function: { name: 'read_file', arguments: '这不是 JSON' } },
        ],
      },
      { role: 'tool', toolCallId: 'tu1', content: 'A' },
      { role: 'tool', toolCallId: 'tu2', content: 'B' },
      { role: 'assistant', content: '完成' },
    ]
    await anthropic().chat(http, req({ messages }))
    expect(http.last.json.messages).toEqual([
      { role: 'user', content: '读两个文件' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的' },
          { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'tu2', name: 'read_file', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'A' },
          { type: 'tool_result', tool_use_id: 'tu2', content: 'B' },
        ],
      },
      { role: 'assistant', content: '完成' },
    ])
  })

  it('assistant 无文本时只有 tool_use 块', async () => {
    const http = new FakeHttp({ text: '{"content":[]}' })
    await anthropic().chat(
      http,
      req({
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', toolCalls: [{ id: 't', function: { name: 'f', arguments: '{}' } }] },
        ],
      }),
    )
    expect(http.last.json.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't', name: 'f', input: {} }],
    })
  })
})

describe('AnthropicProvider.chat 响应解析', () => {
  it('拼接多个 text 块并映射 usage', async () => {
    const http = new FakeHttp({
      text: JSON.stringify({
        content: [{ type: 'text', text: '你好' }, { type: 'text', text: '，世界' }],
        usage: { input_tokens: 11, output_tokens: 22 },
      }),
    })
    const res = await anthropic().chat(http, req())
    expect(res).toEqual({
      kind: 'text',
      content: '你好，世界',
      usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
    })
  })

  it('tool_use 块产出 toolCalls（arguments 为 JSON 字符串）', async () => {
    const http = new FakeHttp({
      text: JSON.stringify({
        content: [
          { type: 'text', text: '我看一下' },
          { type: 'tool_use', id: 'tu9', name: 'read_file', input: { path: 'a.ts' } },
        ],
      }),
    })
    const res = await anthropic().chat(http, req())
    expect(res.kind).toBe('toolCalls')
    if (res.kind === 'toolCalls') {
      expect(res.calls).toEqual([{ id: 'tu9', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }])
      expect(res.content).toBe('我看一下')
      expect(res.usage).toBeUndefined()
    }
  })

  it('tool_use 缺 id 时用 toolu_<序号> 兜底', async () => {
    const http = new FakeHttp({
      text: JSON.stringify({ content: [{ type: 'tool_use', name: 'f', input: { a: 1 } }] }),
    })
    const res = await anthropic().chat(http, req())
    if (res.kind !== 'toolCalls') throw new Error('应为 toolCalls')
    expect(res.calls[0]).toEqual({ id: 'toolu_0', function: { name: 'f', arguments: '{"a":1}' } })
  })

  it('content 缺失或不是数组时按空文本处理', async () => {
    const http = new FakeHttp({ text: JSON.stringify({ usage: { input_tokens: 3 } }) })
    const res = await anthropic().chat(http, req())
    expect(res).toEqual({ kind: 'text', content: '', usage: { promptTokens: 3, completionTokens: 0, totalTokens: 3 } })
  })

  it('output_tokens 缺失/非数字时按 0 处理', async () => {
    const http = new FakeHttp({ text: JSON.stringify({ content: [], usage: { input_tokens: 5, output_tokens: 'x' } }) })
    const res = await anthropic().chat(http, req())
    if (res.kind !== 'text') throw new Error('应为 text')
    expect(res.usage).toEqual({ promptTokens: 5, completionTokens: 0, totalTokens: 5 })
  })

  it('响应体不是 JSON → Llm 类 AppError', async () => {
    const http = new FakeHttp({ text: 'not-json' })
    const e = await anthropic().chat(http, req()).catch((err: unknown) => err)
    expect(e).toBeInstanceOf(AppError)
    expect((e as AppError).kind).toBe('llm')
    expect((e as AppError).message).toContain('LLM 响应不是有效 JSON: not-json')
  })

  it('HTTP 错误状态码归类并保留 status', async () => {
    const http = new FakeHttp({ status: 529, text: 'overloaded_error' })
    const e = (await anthropic().chat(http, req()).catch((err: unknown) => err)) as AppError
    expect(e).toBeInstanceOf(AppError)
    expect(e.status).toBe(529)
    expect(e.isServerError()).toBe(true)
    expect(e.message).toContain('LLM API 错误 (HTTP 529): overloaded_error')
  })

  it('429 携带 retry-after 时暴露 retryAfter', async () => {
    const http = new FakeHttp({ status: 429, text: 'slow', headers: { 'retry-after': '7' } })
    const e = (await anthropic().chat(http, req()).catch((err: unknown) => err)) as AppError
    expect(e.isRateLimited()).toBe(true)
    expect(e.retryAfter()).toBe(7000)
  })

  it('传输层异常 → 连接中断（connect=true）', async () => {
    const http = new FakeHttp({ throwOnRequest: new Error('socket hang up') })
    const e = (await anthropic().chat(http, req()).catch((err: unknown) => err)) as AppError
    expect(e).toBeInstanceOf(AppError)
    expect(e.isConnectError()).toBe(true)
    expect(e.message).toContain('连接中断: socket hang up')
  })
})

describe('AnthropicProvider.chatStream 事件解析', () => {
  const textStream = [
    sse({ type: 'message_start', message: { usage: { input_tokens: 100 } } }),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '世界' } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'message_delta', usage: { output_tokens: 30 } }),
    sse({ type: 'message_stop' }),
  ]

  it('文本增量按序产出，末尾补 usage + done', async () => {
    const http = new FakeHttp({ sse: textStream })
    const events = await collect(anthropic().chatStream(http, req()))
    expect(events).toEqual([
      { kind: 'chunk', content: '你好' },
      { kind: 'chunk', content: '世界' },
      { kind: 'usage', usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 } },
      { kind: 'done' },
    ])
  })

  it('tool_use 增量累积合法 JSON 参数并带上 id/name', async () => {
    const http = new FakeHttp({
      sse: [
        sse({ type: 'message_start', message: { usage: { input_tokens: 1 } } }),
        sse({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
        }),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path' } }),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '":"a.ts"}' } }),
        sse({ type: 'content_block_stop', index: 0 }),
        sse({ type: 'message_delta', usage: { output_tokens: 2 } }),
      ],
    })
    const events = await collect(anthropic().chatStream(http, req()))
    const deltas = events.filter((e): e is Extract<LlmStreamEvent, { kind: 'toolCallDelta' }> => e.kind === 'toolCallDelta')
    expect(deltas).toHaveLength(2)
    expect(deltas[0]?.call.function.arguments).toBe('{"path')
    const last = deltas[1]
    if (last?.kind !== 'toolCallDelta') throw new Error('应为 toolCallDelta')
    expect(last.index).toBe(0)
    expect(last.call).toEqual({ id: 'toolu_1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } })
    expect(JSON.parse(last.call.function.arguments)).toEqual({ path: 'a.ts' })
    expect(events[events.length - 1]).toEqual({ kind: 'done' })
  })

  it('多个 tool_use 块按 index 独立累积参数与 id', async () => {
    const http = new FakeHttp({
      sse: [
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_a', name: 'read_file', input: {} } }),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } }),
        sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_b', name: 'list_dir', input: {} } }),
        sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"b"}' } }),
      ],
    })
    const events = await collect(anthropic().chatStream(http, req()))
    const deltas = events.filter((e): e is Extract<LlmStreamEvent, { kind: 'toolCallDelta' }> => e.kind === 'toolCallDelta')
    expect(deltas.map((d) => [d.index, d.call.id, d.call.function.name])).toEqual([
      [0, 'tu_a', 'read_file'],
      [1, 'tu_b', 'list_dir'],
    ])
    expect(deltas.map((d) => (d.kind === 'toolCallDelta' ? JSON.parse(d.call.function.arguments) : null))).toEqual([
      { path: 'a' },
      { path: 'b' },
    ])
  })

  it('content_block_start 直接携带完整 input 且无增量（网关形态）→ 块结束时补发完整 toolCallDelta', async () => {
    const http = new FakeHttp({
      sse: [
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_gw', name: 'read_file', input: { path: 'a.ts' } } }),
        sse({ type: 'content_block_stop', index: 0 }),
      ],
    })
    const events = await collect(anthropic().chatStream(http, req()))
    const deltas = events.filter((e): e is Extract<LlmStreamEvent, { kind: 'toolCallDelta' }> => e.kind === 'toolCallDelta')
    expect(deltas).toEqual([
      { kind: 'toolCallDelta', index: 0, call: { id: 'tu_gw', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } } },
    ])
    expect(JSON.parse(deltas[0]?.call.function.arguments ?? '')).toEqual({ path: 'a.ts' })
  })

  it('请求阶段已 abort：静默结束，不产出事件也不抛错', async () => {
    const http = new FakeHttp({ throwOnRequest: new Error('socket hang up') })
    const ac = new AbortController()
    ac.abort()
    const events = await collect(anthropic().chatStream(http, req(), ac.signal))
    expect(events).toEqual([])
  })

  it('流中 abort：干净收尾（补 usage + done）而不抛错', async () => {
    const enc = new TextEncoder()
    // 首帧正常下发后挂起（不 close），由 abort 触发 reader.cancel 结束流
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const frame =
          sse({ type: 'message_start', message: { usage: { input_tokens: 7 } } }) +
          sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
          sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } })
        controller.enqueue(enc.encode(frame))
      },
    })
    const http: HttpClientLike = { request: async () => ({ status: 200, headers: {}, body }) }
    const ac = new AbortController()
    const events: LlmStreamEvent[] = []
    for await (const e of anthropic().chatStream(http, req(), ac.signal)) {
      events.push(e)
      if (e.kind === 'chunk') ac.abort()
    }
    expect(events.map((e) => e.kind)).toEqual(['chunk', 'usage', 'done'])
    const usage = events.find((e): e is Extract<LlmStreamEvent, { kind: 'usage' }> => e.kind === 'usage')
    expect(usage?.usage.promptTokens).toBe(7)
  })

  it('流读取失败且已 abort：不抛错，只补 done', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('connection reset'))
      },
    })
    const http: HttpClientLike = { request: async () => ({ status: 200, headers: {}, body }) }
    const ac = new AbortController()
    ac.abort()
    const events = await collect(anthropic().chatStream(http, req(), ac.signal))
    expect(events).toEqual([{ kind: 'done' }])
  })

  it('thinking 增量映射为 reasoning；signature 块不误当思考文本', async () => {
    const http = new FakeHttp({
      sse: [
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一想' } }),
        // signature_delta 携带的是 base64 签名（字段名 signature），不应作为推理文本外泄
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc==' } }),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking', thinking: '非预期 delta 类型' } }),
      ],
    })
    const events = await collect(anthropic().chatStream(http, req()))
    expect(events).toEqual([
      { kind: 'reasoning', content: '想一想' },
      { kind: 'usage', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
      { kind: 'done' },
    ])
  })

  it('忽略非 JSON 与未涉及的块类型', async () => {
    const http = new FakeHttp({
      sse: ['data: 这不是json\n\n', ': 注释\n\n', sse({ type: 'ping' }), sse({ type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: 'x' } }), sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '应被忽略' } })],
    })
    const events = await collect(anthropic().chatStream(http, req()))
    expect(events.map((e) => e.kind)).toEqual(['usage', 'done'])
  })

  it('error 事件抛出 Anthropic 流错误', async () => {
    const http = new FakeHttp({ sse: [sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })] })
    const gen = anthropic().chatStream(http, req())
    await expect(collect(gen)).rejects.toThrow(/Anthropic 流错误: Overloaded/)
  })

  it('error 事件缺 message 时用 unknown 兜底', async () => {
    const http = new FakeHttp({ sse: [sse({ type: 'error' })] })
    await expect(collect(anthropic().chatStream(http, req()))).rejects.toThrow('Anthropic 流错误: unknown')
  })

  it('流建立前返回 4xx 时抛出带 status 的 AppError', async () => {
    const http = new FakeHttp({ status: 401, text: '{"error":{"type":"authentication_error"}}' })
    const e = (await collect(anthropic().chatStream(http, req())).catch((err: unknown) => err)) as AppError
    expect(e).toBeInstanceOf(AppError)
    expect(e.status).toBe(401)
    expect(e.message).toContain('authentication_error')
  })

  it('流建立前的传输异常归类为连接错误', async () => {
    const http = new FakeHttp({ throwOnRequest: new Error('connect ECONNREFUSED') })
    const e = (await collect(anthropic().chatStream(http, req())).catch((err: unknown) => err)) as AppError
    expect(e.isConnectError()).toBe(true)
    expect(e.message).toContain('connect ECONNREFUSED')
  })
})

describe('OllamaProvider', () => {
  it('默认 apiUrl 与占位 apiKey，走 OpenAI 兼容端点', async () => {
    const http = new FakeHttp({ text: '{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}' })
    const p = new OllamaProvider({ name: 'llama' })
    expect(p.type).toBe('ollama')
    const res = await p.chat(http, req())
    expect(http.last.url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect((http.last.init.headers as Record<string, string>).authorization).toBe('Bearer ollama')
    expect(res).toEqual({ kind: 'text', content: 'ok', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } })
  })

  it('显式 apiUrl 覆盖默认值', async () => {
    const http = new FakeHttp({ text: '{"choices":[]}' })
    await new OllamaProvider({ name: 'llama', apiUrl: 'http://host:1234/v1', apiKey: 'k' }).chat(http, req())
    expect(http.last.url).toBe('http://host:1234/v1/chat/completions')
    expect((http.last.init.headers as Record<string, string>).authorization).toBe('Bearer k')
  })
})

describe('createProvider 工厂', () => {
  function cfg(provider: string): ProviderConfig {
    return {
      name: 'm',
      provider: provider as ProviderConfig['provider'],
      apiUrl: 'https://x.test/v1',
      apiKey: 'k',
      model: 'mm',
      maxOutputTokens: 512,
    }
  }

  it.each([
    ['openai', 'openai'],
    ['openai-compatible', 'openai-compatible'],
    ['ollama', 'ollama'],
    ['anthropic', 'anthropic'],
  ] as const)('%s → type=%s', (input, expected) => {
    const p = createProvider(cfg(input))
    expect(p.type).toBe(expected)
    expect(p.name).toBe('m')
  })

  it('未知 provider 类型抛出可读错误', () => {
    expect(() => createProvider(cfg('grok'))).toThrow(/未知 provider 类型: grok/)
  })
})

describe('provider 共享纯函数', () => {
  it('joinUrl 规整两侧斜杠', () => {
    expect(joinUrl('https://a.test/v1/', '/messages')).toBe('https://a.test/v1/messages')
    expect(joinUrl('https://a.test/v1', 'messages')).toBe('https://a.test/v1/messages')
    expect(joinUrl('https://a.test///', '///messages')).toBe('https://a.test/messages')
  })

  it('toOpenAiMessages 保留 tool 与 assistant 协议字段', () => {
    expect(
      toOpenAiMessages([
        { role: 'system', content: 's' },
        { role: 'assistant', content: null as unknown as string, toolCalls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', content: 'r' },
      ]),
    ).toEqual([
      { role: 'system', content: 's' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: '', content: 'r' },
    ])
  })

  it('OpenAI 请求体按需带 max_tokens / reasoning_effort', async () => {
    const http = new FakeHttp({ text: '{"choices":[]}' })
    await new OpenAIProvider({ name: 'gpt', apiUrl: 'https://o.test/v1', apiKey: 'k' }).chat(
      http,
      req({ maxOutputTokens: 64, reasoningEffort: 'high' }),
    )
    expect(http.last.json.max_tokens).toBe(64)
    expect(http.last.json.reasoning_effort).toBe('high')
    expect(http.last.json.stream_options).toBeUndefined()
  })
})
