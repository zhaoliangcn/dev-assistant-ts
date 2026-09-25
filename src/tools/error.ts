/**
 * 工具错误类别。
 * 与 LLM 重试分类（RetryClass）区分：ErrorCategory 描述"工具执行失败"的语义，
 * 供 Agent 决定如何处理（是否重试、是否告知 LLM）。
 */
export type ErrorCategory = 'transient' | 'permanent' | 'llm'

/** 工具执行错误（handler 内部抛出，registry 捕获后转为 ToolResult） */
export class ToolError extends Error {
  readonly category: ErrorCategory

  constructor(message: string, category: ErrorCategory = 'permanent') {
    super(message)
    this.name = 'ToolError'
    this.category = category
  }

  static transient(message: string): ToolError {
    return new ToolError(message, 'transient')
  }
  static permanent(message: string): ToolError {
    return new ToolError(message, 'permanent')
  }
}
