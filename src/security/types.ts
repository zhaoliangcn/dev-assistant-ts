/**
 * 安全与审批类型（对齐 Rust 版 `src/security/types.rs`）。
 */

/** 危险级别 */
export type DangerLevel = 'low' | 'medium' | 'high' | 'critical'

/** 审批类型 */
export type ApprovalType = 'auto' | 'one-time' | 'session'

/** 审批作用域：决定审批记录的 key 粒度 */
export type ApprovalScope = 'none' | 'command' | 'path' | 'file'

/** 审批要求（SecurityPolicy 评估产出） */
export interface ApprovalRequirement {
  approvalType: ApprovalType
  dangerThreshold: DangerLevel
  requiresUserConfirmation: boolean
  validitySeconds: number
  scope: ApprovalScope
}

/** 安全评估结果 */
export interface SecurityEvaluation {
  dangerLevel: DangerLevel
  reasons: string[]
  approvalRequirement?: ApprovalRequirement
}

/** 危险级别排序权重（用于阈值比较） */
export const DANGER_WEIGHT: Record<DangerLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
}
