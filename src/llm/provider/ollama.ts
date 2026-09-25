import { OpenAIBase } from './openai.js'

/**
 * Ollama 本地模型（OpenAI 兼容端点 `/v1/chat/completions`）。
 * 默认 apiUrl `http://127.0.0.1:11434/v1`。
 */
export class OllamaProvider extends OpenAIBase {
  constructor(opts: { name: string; apiUrl?: string; apiKey?: string; maxOutputTokens?: number }) {
    super({
      name: opts.name,
      type: 'ollama',
      apiUrl: opts.apiUrl ?? 'http://127.0.0.1:11434/v1',
      apiKey: opts.apiKey ?? 'ollama',
      maxOutputTokens: opts.maxOutputTokens,
    })
  }
}
