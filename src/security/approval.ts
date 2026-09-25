import { log } from '../utils/logger.js'
import type { ApprovalRequirement } from './types.js'

/**
 * ApprovalManager：审批记录管理 + 用户确认。
 * 对齐设计文档 9.2。
 *
 * - auto     直接通过
 * - one-time 每次执行都确认（记录不保留）
 * - session  会话内按 scope 缓存（有效期内不重复确认）
 *
 * 确认方式由 `requestConfirmation` 回调注入（CLI 用终端 prompt，Web 用 WS 推送），
 * 使本类与 UI 解耦、可单测。
 */

export interface ApprovalRecord {
  approvedAt: number
  validitySeconds: number
  type: 'one-time' | 'session'
  scopeKey: string
}

export type ConfirmHandler = (requirement: ApprovalRequirement, scope: string) => Promise<boolean>

export class ApprovalManager {
  private approvals = new Map<string, ApprovalRecord>()
  /** --no-approval 模式：全部自动通过 */
  private disabled = false

  constructor(private confirm: ConfirmHandler) {}

  /** 替换确认回调（如 CLI 从终端 prompt 切到 ink UI 审批桥） */
  setConfirm(confirm: ConfirmHandler): void {
    this.confirm = confirm
  }

  /** 关闭审批（对应 CLI --no-approval） */
  setDisabled(disabled: boolean): void {
    this.disabled = disabled
  }

  isDisabled(): boolean {
    return this.disabled
  }

  /**
   * 检查是否已获审批。
   * @param requirement 安全评估产出的审批要求
   * @param scope 作用域 key（approvalScopeKey 产出）
   * @returns true=已获批准 / 无需审批；false=被拒绝
   */
  async check(requirement: ApprovalRequirement, scope: string): Promise<boolean> {
    if (this.disabled) return true
    if (!requirement || requirement.approvalType === 'auto' || !requirement.requiresUserConfirmation) {
      return true
    }
    if (requirement.approvalType === 'one-time') {
      // 每次都要确认
      return this.requestAndRecord(requirement, scope, false)
    }

    // session 级：查缓存（key 含审批类型 + scope，避免不同 scope 语义混用）
    const key = `${requirement.approvalType}:${scope}`
    const existing = this.approvals.get(key)
    if (existing && this.isValid(existing)) {
      log.debug('审批缓存命中', { key })
      return true
    }

    const confirmed = await this.requestAndRecord(requirement, scope, true)
    if (confirmed) {
      this.approvals.set(key, {
        approvedAt: Date.now(),
        validitySeconds: requirement.validitySeconds,
        type: 'session',
        scopeKey: scope,
      })
    }
    return confirmed
  }

  private async requestAndRecord(
    requirement: ApprovalRequirement,
    scope: string,
    _record: boolean,
  ): Promise<boolean> {
    try {
      const confirmed = await this.confirm(requirement, scope)
      if (confirmed) {
        log.info('审批通过', { level: requirement.dangerThreshold, scope })
      } else {
        log.warn('审批被拒绝', { level: requirement.dangerThreshold, scope })
      }
      return confirmed
    } catch (e) {
      // 确认过程出错视为拒绝（安全优先）
      log.error(`审批确认过程出错: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  private isValid(record: ApprovalRecord): boolean {
    return Date.now() - record.approvedAt < record.validitySeconds * 1000
  }

  /** 会话结束时清空 */
  clear(): void {
    this.approvals.clear()
  }

  /** 当前有效审批数（调试用） */
  activeCount(): number {
    let n = 0
    for (const r of this.approvals.values()) if (this.isValid(r)) n++
    return n
  }
}
