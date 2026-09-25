import type { LlmMessage, ToolCall } from '../llm/models.js'
import { estimateMessageTokens, estimateMessagesTokens } from './token-counter.js'

/**
 * ContextManager：维护对话消息序列 + token 预算。
 * 对齐设计文档 8.2。
 *
 * 预算压力分级（按占用比）：
 * - < 0.5    low
 * - < 0.75   medium
 * - < 0.9    high
 * - >= 0.9   critical（触发压缩）
 */

export type Pressure = 'low' | 'medium' | 'high' | 'critical'

export interface ContextBudget {
  current: number
  max: number
  ratio: number
  pressure: Pressure
  /** 留给输出的余量（估算） */
  reservedForOutput: number
}

const DEFAULT_MAX_TOKENS = 262_144
/** 输出预留：给模型回复留的空间 */
const OUTPUT_RESERVE = 8192

export class ContextManager {
  private messages: LlmMessage[] = []
  private tokenEstimate = 0
  private toolsTokenEstimate = 0

  constructor(
    private maxTokens: number = DEFAULT_MAX_TOKENS,
    private initialSystem?: string,
  ) {
    if (initialSystem) this.appendSystem(initialSystem)
  }

  // -------------------------------------------------------------------------
  // 追加
  // -------------------------------------------------------------------------

  appendSystem(content: string): void {
    this.push({ role: 'system', content })
  }

  appendUser(content: string): void {
    this.push({ role: 'user', content })
  }

  appendAssistant(content: string, toolCalls?: ToolCall[]): void {
    this.push({
      role: 'assistant',
      content: content || undefined,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    })
  }

  appendToolResult(callId: string, content: string): void {
    this.push({ role: 'tool', toolCallId: callId, content })
  }

  private push(message: LlmMessage): void {
    this.messages.push(message)
    this.tokenEstimate += estimateMessageTokens(message)
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  toMessages(): LlmMessage[] {
    return [...this.messages]
  }

  get length(): number {
    return this.messages.length
  }

  get lastMessage(): LlmMessage | undefined {
    return this.messages[this.messages.length - 1]
  }

  /** 最近 N 条消息 */
  tail(n: number): LlmMessage[] {
    return this.messages.slice(-n)
  }

  /** 设置工具 schema 的 token 估算（每次请求都会附带） */
  setToolsTokens(tokens: number): void {
    this.toolsTokenEstimate = tokens
  }

  /** 当前 token 估算（含工具 schema 固定开销） */
  totalTokens(): number {
    return this.tokenEstimate + this.toolsTokenEstimate
  }

  budget(): ContextBudget {
    const current = this.totalTokens()
    const ratio = this.maxTokens > 0 ? current / this.maxTokens : 0
    const pressure: Pressure =
      ratio < 0.5 ? 'low' : ratio < 0.75 ? 'medium' : ratio < 0.9 ? 'high' : 'critical'
    return {
      current,
      max: this.maxTokens,
      ratio,
      pressure,
      reservedForOutput: OUTPUT_RESERVE,
    }
  }

  // -------------------------------------------------------------------------
  // 压缩支持（compressor 调用）
  // -------------------------------------------------------------------------

  /** 保留 system 消息与最近消息，丢弃中间的（压缩后重建） */
  resetAndRebuild(keepSystem: LlmMessage[], keptTail: LlmMessage[]): void {
    this.messages = [...keepSystem, ...keptTail]
    this.tokenEstimate = estimateMessagesTokens(this.messages)
  }

  /** 完全重置（restart 用） */
  reset(systemPrompt?: string): void {
    this.messages = []
    this.tokenEstimate = 0
    if (systemPrompt) this.appendSystem(systemPrompt)
  }

  get maxTokenLimit(): number {
    return this.maxTokens
  }
}
