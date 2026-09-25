/**
 * LLM 核心类型定义。
 * 对齐 dev-assistant-rs `src/llm/models.rs`。
 */

/** Provider 类型（与 Rust 版枚举一致） */
export type ProviderType = 'openai' | 'openai-compatible' | 'anthropic' | 'ollama'

/** 推理强度（可选，部分模型支持） */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'none' | 'max' | 'xhigh'

/** 单个 provider 配置（对应 .dev-assistant-models.toml 的 [[models]] 条目） */
export interface ProviderConfig {
  name: string
  provider: ProviderType
  apiUrl: string
  apiKey?: string
  model: string
  temperature?: number
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
}

/** 模型配置（TOML 根对象） */
export interface ModelsConfig {
  models: ProviderConfig[]
}

/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** 一条对话消息（内部统一表示，与具体 provider 协议解耦） */
export interface LlmMessage {
  role: MessageRole
  content?: string
  /** 助手消息携带的工具调用（role === 'assistant' 时） */
  toolCalls?: ToolCall[]
  /** 工具结果消息关联的调用 id（role === 'tool' 时） */
  toolCallId?: string
}

/** 一次工具调用（OpenAI 协议形式，arguments 为 JSON 字符串） */
export interface ToolCall {
  id: string
  function: {
    name: string
    arguments: string
  }
}

/** 工具 schema（发给 LLM 的函数定义） */
export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: object
  }
}

/** LLM 请求（provider 无关的统一请求） */
export interface LlmRequest {
  model: string
  messages: LlmMessage[]
  tools?: ToolSchema[]
  temperature: number
  maxOutputTokens?: number
  reasoningEffort?: string
}

/** LLM 非流式响应 */
export type LlmResponse =
  | { kind: 'text'; content: string; usage?: TokenUsage }
  | { kind: 'toolCalls'; calls: ToolCall[]; usage?: TokenUsage; content?: string }
  | { kind: 'error'; message: string }

/** Token 用量 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** 流式事件（provider 无关，Agent 消费） */
export type LlmStreamEvent =
  /** 文本增量 */
  | { kind: 'chunk'; content: string }
  /** 思考过程增量（reasoning / thinking） */
  | { kind: 'reasoning'; content: string }
  /** 工具调用增量（累积式，按 index 合并；每次携带该 index 当前已知的完整 call） */
  | { kind: 'toolCallDelta'; index: number; call: ToolCall }
  /** token 用量 */
  | { kind: 'usage'; usage: TokenUsage }
  /** 流结束 */
  | { kind: 'done' }

/** 流式完成的最终汇总（从事件流中聚合） */
export interface StreamOutcome {
  text: string
  toolCalls: ToolCall[]
  usage?: TokenUsage
  error?: string
}
