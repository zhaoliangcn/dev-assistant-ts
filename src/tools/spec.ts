import type { DangerLevel } from '../security/types.js'

/**
 * 工具安全策略定义。
 * 每个工具的"固有危险级别"在此集中声明（对齐 Rust 版 `tools/spec.rs`），
 * SecurityPolicy 据此产出 SecurityEvaluation。
 */
export interface ToolSpec {
  name: string
  description: string
  /** 参数 JSON Schema */
  parameters: object
  /** 固有危险级别 */
  dangerLevel: DangerLevel
  /** 跳过安全评估（纯元工具，如 finish/restart） */
  skipSecurity?: boolean
  /** 是否需要审批（critical 默认每次；high/medium 可会话级） */
  approvalType?: 'auto' | 'one-time' | 'session'
  /** 审批有效期（秒） */
  validitySeconds?: number
  /** 审批作用域：none=全局 / command=按命令 / path=按路径 / file=按文件 */
  approvalScope?: 'none' | 'command' | 'path' | 'file'
}
