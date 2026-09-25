import type { ProviderConfig, ProviderType } from '../models.js'
import { OpenAIProvider } from './openai.js'
import { OllamaProvider } from './ollama.js'
import { AnthropicProvider } from './anthropic.js'
import type { LlmProvider } from './types.js'

/**
 * Provider 工厂：按配置创建 LlmProvider 实例。
 * 对齐 Rust 版 `create_provider`。
 */
export function createProvider(cfg: ProviderConfig): LlmProvider {
  switch (cfg.provider) {
    case 'openai':
      return new OpenAIProvider({
        name: cfg.name,
        apiUrl: cfg.apiUrl,
        apiKey: cfg.apiKey,
        maxOutputTokens: cfg.maxOutputTokens,
        reasoningEffort: cfg.reasoningEffort,
      })
    case 'openai-compatible':
      return new OpenAIProvider({
        name: cfg.name,
        apiUrl: cfg.apiUrl,
        apiKey: cfg.apiKey,
        maxOutputTokens: cfg.maxOutputTokens,
        reasoningEffort: cfg.reasoningEffort,
      }).withType('openai-compatible')
    case 'ollama':
      return new OllamaProvider({
        name: cfg.name,
        apiUrl: cfg.apiUrl,
        apiKey: cfg.apiKey,
        maxOutputTokens: cfg.maxOutputTokens,
      })
    case 'anthropic':
      return new AnthropicProvider({
        name: cfg.name,
        apiUrl: cfg.apiUrl,
        apiKey: cfg.apiKey,
        maxOutputTokens: cfg.maxOutputTokens,
      })
    default:
      throw new Error(`未知 provider 类型: ${String(cfg.provider)}`)
  }
}

export type { ProviderType }
