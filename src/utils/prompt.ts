import * as readline from 'node:readline'

/**
 * 终端交互 prompt（审批确认 / REPL 输入共用）。
 * 用 node:readline 直接操作 stdin，避免引入额外依赖。
 */

let rl: readline.Interface | null = null

/** 获取（或创建）共享 readline 实例 */
export function getReadline(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    })
  }
  return rl
}

/** 销毁 readline（进程退出前） */
export function closeReadline(): void {
  rl?.close()
  rl = null
}

/** 单行文本输入 */
export function promptText(query: string): Promise<string> {
  return new Promise((resolve) => {
    const interface_ = getReadline()
    interface_.question(query, (answer) => {
      resolve(answer.trim())
    })
  })
}

/** y/N 确认；非 TTY（管道）默认拒绝（安全优先） */
export function promptConfirm(query: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // 非交互环境：无法确认，安全拒绝
    console.error('非交互环境，无法进行审批确认，已拒绝（可加 --no-approval 自动放行）')
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const interface_ = getReadline()
    interface_.question(query, (answer) => {
      const a = answer.trim().toLowerCase()
      resolve(a === 'y' || a === 'yes' || a === '是')
    })
  })
}
