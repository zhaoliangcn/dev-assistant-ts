/**
 * UI 审批桥（ink REPL 专用）。
 *
 * 背景：Agent 审批发生在 App/registry 内部（confirmApproval 回调），
 * 而 ink REPL 的输入由 useInput 接管，直接 readline.question 会与
 * ink 的 raw 输入模式冲突。桥模式：confirmApproval 回调挂起一个 Promise，
 * InkRepl 组件订阅到审批请求后在 UI 内渲染 [y/N] 提示，用户按键后 resolve。
 */

export interface ApprovalRequestInfo {
  id: number
  /** 危险级别 */
  dangerLevel: string
  /** 审批类型 */
  approvalType: string
  /** 作用域 */
  scope: string
  /** 原因（策略评估给出） */
  reasons: string[]
}

type ApprovalListener = (request: ApprovalRequestInfo | null) => void

export class ApprovalBridge {
  private listener: ApprovalListener | null = null
  private current: { info: ApprovalRequestInfo; resolve: (ok: boolean) => void } | null = null
  private seq = 0

  /** confirmApproval 回调：挂起等待 UI 响应 */
  requestApproval = (requirement: {
    approvalType: string
    dangerThreshold: string
    requiresUserConfirmation: boolean
    validitySeconds: number
    scope: string
  }, scope: string): Promise<boolean> => {
    if (this.current) {
      // 并发审批：直接拒绝（UI 一次只处理一个）
      return Promise.resolve(false)
    }
    const info: ApprovalRequestInfo = {
      id: ++this.seq,
      dangerLevel: requirement.dangerThreshold,
      approvalType: requirement.approvalType,
      scope,
      reasons: [],
    }
    return new Promise<boolean>((resolve) => {
      this.current = { info, resolve }
      this.listener?.(info)
    })
  }

  /** UI 订阅审批请求 */
  subscribe(listener: ApprovalListener): void {
    this.listener = listener
  }

  get pending(): ApprovalRequestInfo | null {
    return this.current?.info ?? null
  }

  /** UI 回答审批 */
  answer(ok: boolean): void {
    if (!this.current) return
    const { resolve } = this.current
    this.current = null
    this.listener?.(null)
    resolve(ok)
  }
}
