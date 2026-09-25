import { Agent, type Dispatcher } from 'undici'
import type { Readable } from 'node:stream'
import type {
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  ProviderConfig,
  ToolSchema,
} from './models.js'
import { createProvider } from './provider/factory.js'
import type { LlmProvider, HttpClientLike, HttpResponse } from './provider/types.js'
import { retryWithBackoff } from './retry.js'
import { AppError } from '../utils/error.js'
import { sleep } from '../utils/sleep.js'
import { log } from '../utils/logger.js'

/**
 * LLM 客户端：多 provider 容器 + 故障转移。
 * 对齐 Rust 版 `src/llm/client.rs`。
 *
 * 行为：
 * - 无 provider → 抛出含 NO_MODEL_HINT 的错误
 * - 按 activeIdx 顺序轮询 provider，失败则转移到下一个（provider 间 1s 延迟）
 * - 每个 provider 内部走 retryWithBackoff（transient/network 分类）
 * - 支持运行时热切换活跃 provider（setActiveByName）
 * - 底层用 undici Agent（连接池 + 精细超时）
 */

export const NO_MODEL_HINT =
  '未配置任何 LLM provider。请创建 .dev-assistant-models.toml（参考 .dev-assistant-models.toml.example）并用 --provider/--model 指定。'

export interface LlmClientOptions {
  /** LLM_CONNECT_TIMEOUT_SECS（默认 30） */
  connectTimeoutSecs?: number
  /** 请求 headers 超时（默认 600s，长思考模型） */
  headersTimeoutSecs?: number
  /** body 空闲超时（默认 300s） */
  bodyTimeoutSecs?: number
  /** 注入 undici dispatcher（测试用） */
  dispatcher?: Dispatcher
}

export class LlmClient {
  private readonly providers: LlmProvider[]
  private readonly providerConfigs: ProviderConfig[]
  private activeIdx = 0
  private readonly dispatcher: Dispatcher
  private readonly http: HttpClientLike

  constructor(configs: ProviderConfig[], opts: LlmClientOptions = {}) {
    this.providerConfigs = configs
    this.providers = configs.map((c) => createProvider(c))

    const connectTimeout = (opts.connectTimeoutSecs ?? envInt('LLM_CONNECT_TIMEOUT_SECS', 30)) * 1000
    const headersTimeout = (opts.headersTimeoutSecs ?? 600) * 1000
    const bodyTimeout = (opts.bodyTimeoutSecs ?? 300) * 1000
    this.dispatcher =
      opts.dispatcher ??
      new Agent({
        connectTimeout,
        headersTimeout,
        bodyTimeout,
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 60_000,
      })
    this.http = createHttpClient(this.dispatcher)
  }

  isEmpty(): boolean {
    return this.providers.length === 0
  }

  /** 已配置的 provider 名称列表 */
  providerNames(): string[] {
    return this.providerConfigs.map((c) => c.name)
  }

  /** 当前活跃 provider 配置 */
  activeConfig(): ProviderConfig | undefined {
    return this.providerConfigs[this.activeIdx]
  }

  /** 运行时热切换活跃 provider（按名称） */
  setActiveByName(name: string): boolean {
    const idx = this.providerConfigs.findIndex((c) => c.name === name)
    if (idx === -1) return false
    this.activeIdx = idx
    return true
  }

  /** 非流式调用（含故障转移） */
  async call(messages: LlmMessage[], tools: ToolSchema[] = []): Promise<LlmResponse> {
    if (this.isEmpty()) throw AppError.Llm(NO_MODEL_HINT)

    const n = this.providers.length
    const startIdx = this.activeIdx % n
    let lastError: AppError | null = null

    for (let offset = 0; offset < n; offset++) {
      const idx = (startIdx + offset) % n
      const provider = this.providers[idx]
      const cfg = this.providerConfigs[idx]
      if (!provider || !cfg) continue

      if (offset > 0) {
        const from = this.providerConfigs[startIdx]?.name ?? '?'
        log.warn(`LLM 故障转移: ${from} → ${cfg.name}`)
        this.activeIdx = idx
      }

      const request = buildRequest(cfg, messages, tools)
      try {
        return await retryWithBackoff(() => provider.chat(this.http, request))
      } catch (e) {
        lastError = e instanceof AppError ? e : AppError.Llm(String(e))
        log.warn(`provider 调用失败: ${cfg.name} - ${lastError.message}`)
        if (offset < n - 1) await sleep(1000) // provider 间短暂延迟
      }
    }

    throw lastError ?? AppError.Llm('所有 LLM provider 均不可用')
  }

  /** 流式调用（含故障转移）。首个事件产出前失败会转移到下一个 provider。 */
  async callStream(
    messages: LlmMessage[],
    tools: ToolSchema[] = [],
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<LlmStreamEvent>> {
    if (this.isEmpty()) throw AppError.Llm(NO_MODEL_HINT)

    const n = this.providers.length
    const startIdx = this.activeIdx % n
    let lastError: AppError | null = null

    for (let offset = 0; offset < n; offset++) {
      const idx = (startIdx + offset) % n
      const provider = this.providers[idx]
      const cfg = this.providerConfigs[idx]
      if (!provider || !cfg) continue

      const request = buildRequest(cfg, messages, tools)
      try {
        const gen = retryStream(() => provider.chatStream(this.http, request, signal))
        // 驱动到首个事件，确认流成功启动
        const first = await gen.next()
        const firstEvent = first.done ? undefined : first.value
        return (async function* () {
          if (firstEvent !== undefined) yield firstEvent
          yield* gen
        })()
      } catch (e) {
        lastError = e instanceof AppError ? e : AppError.Llm(String(e))
        log.warn(`provider 流式调用失败: ${cfg.name} - ${lastError.message}`)
        if (offset > 0) {
          const from = this.providerConfigs[startIdx]?.name ?? '?'
          log.warn(`LLM 流式故障转移: ${from} → ${cfg.name}`)
          this.activeIdx = idx
        }
        if (offset < n - 1) await sleep(1000)
      }
    }

    throw lastError ?? AppError.Llm('所有 LLM provider 均不可用')
  }

  /** 关闭底层连接池 */
  async close(): Promise<void> {
    await this.dispatcher.close().catch(() => undefined)
  }
}

/** 把统一消息 + 配置构建成 LlmRequest */
function buildRequest(cfg: ProviderConfig, messages: LlmMessage[], tools: ToolSchema[]): LlmRequest {
  return {
    model: cfg.model,
    messages: [...messages],
    tools: [...tools],
    temperature: roundTemperature(cfg.temperature ?? 0.2),
    maxOutputTokens: cfg.maxOutputTokens,
    reasoningEffort: cfg.reasoningEffort,
  }
}

/** temperature 保留两位小数（部分 API 对精度敏感） */
export function roundTemperature(t: number): number {
  return Math.round(t * 100) / 100
}

function envInt(name: string, def: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : def
}

/**
 * 基于 undici dispatcher 构建 fetch 风格 HTTP 客户端。
 * undici request 返回 { statusCode, headers, body: Readable }，
 * 这里把 body 适配成 Web ReadableStream 供 SSE 解析器消费。
 */
function createHttpClient(dispatcher: Dispatcher): HttpClientLike {
  return {
    async request(url: string, init: RequestInit): Promise<HttpResponse> {
      const method = (init.method ?? 'GET').toUpperCase()
      const headers: Record<string, string> = {}
      if (init.headers) {
        if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) headers[k] = v
        } else if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => {
            headers[k] = v
          })
        } else {
          Object.assign(headers, init.headers as Record<string, string>)
        }
      }
      const u = new URL(url)
      const res = await dispatcher.request({
        origin: u.origin,
        path: u.pathname + u.search,
        method,
        headers,
        body: init.body as string | undefined,
        signal: init.signal,
      })
      return {
        status: res.statusCode,
        headers: res.headers as Record<string, string | string[]>,
        body: toWebStream(res.body),
      }
    },
  }
}

/** undici body（node Readable）→ Web ReadableStream<Uint8Array> */
function toWebStream(nodeStream: Readable): ReadableStream<Uint8Array> {
  let done = false
  return new ReadableStream({
    start(c) {
      const finish = () => {
        if (done) return
        done = true
        c.close()
      }
      nodeStream.on('data', (chunk: Buffer) => {
        if (done) return
        c.enqueue(new Uint8Array(chunk))
      })
      nodeStream.on('end', finish)
      nodeStream.on('close', finish)
      nodeStream.on('error', (err) => {
        if (done) return
        done = true
        c.error(err)
      })
    },
    cancel() {
      done = true
      nodeStream.destroy()
    },
  })
}

/**
 * 流式重试包装：仅在"尚未产出任何事件"时重试。
 * 一旦开始产出事件则不再重试（避免重复输出）。
 */
async function* retryStream(
  factory: () => AsyncGenerator<LlmStreamEvent>,
): AsyncGenerator<LlmStreamEvent> {
  let attempt = 0
  for (;;) {
    attempt++
    const gen = factory()
    let yielded = false
    try {
      for await (const event of gen) {
        yielded = true
        yield event
      }
      return
    } catch (e) {
      if (yielded) throw e
      const err = e instanceof AppError ? e : AppError.Llm(String(e))
      const isRetryable = err.isRateLimited() || err.isServerError() || err.isConnectError()
      if (!isRetryable || attempt >= 3) throw err
      const delay = attempt === 1 ? 500 : 1500
      log.debug(`LLM 流重试: attempt=${attempt} delay=${delay}ms error=${err.message}`)
      await sleep(delay)
    }
  }
}
