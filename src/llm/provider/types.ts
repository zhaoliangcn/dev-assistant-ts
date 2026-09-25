import type { LlmRequest, LlmResponse, LlmStreamEvent, ProviderType } from '../models.js'

/**
 * Provider 接口 + HTTP 抽象。
 *
 * 注意：provider 层不直接 import undici —— 通过 HttpClientLike（fetch 风格）
 * 解耦，LlmClient 负责基于 undici Dispatcher 构建适配器。便于单测 mock。
 */

/** 统一 HTTP 响应（body 为 Web ReadableStream） */
export interface HttpResponse {
  status: number
  headers: Record<string, string | string[]>
  body: ReadableStream<Uint8Array>
}

/** fetch 风格 HTTP 客户端 */
export interface HttpClientLike {
  request(url: string, init: RequestInit): Promise<HttpResponse>
}

/**
 * Provider 统一接口。
 * - chat: 非流式（聚合）
 * - chatStream: 流式，产出统一 LlmStreamEvent
 */
export interface LlmProvider {
  readonly name: string
  readonly type: ProviderType

  chat(http: HttpClientLike, request: LlmRequest): Promise<LlmResponse>

  chatStream(http: HttpClientLike, request: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmStreamEvent>
}
