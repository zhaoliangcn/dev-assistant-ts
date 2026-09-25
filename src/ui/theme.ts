import chalk from 'chalk'

/**
 * CLI 配色方案（对齐设计文档 ui/theme.ts；ink Text 的 color 属性用 ANSI 色名）。
 * ink 的 <Text color="cyan"> 接受 ANSI 16 色名，这里统一收敛为主题常量。
 */

export const theme = {
  /** 品牌主色 */
  primary: 'cyan' as const,
  /** 用户消息提示符 */
  user: 'green' as const,
  /** 助手消息 */
  assistant: 'white' as const,
  /** 工具调用 */
  tool: 'magenta' as const,
  /** 状态/次要信息 */
  dim: 'gray' as const,
  /** 警告 */
  warn: 'yellow' as const,
  /** 错误 */
  error: 'red' as const,
  /** 成功 */
  success: 'green' as const,
  /** 审批提示 */
  approval: 'yellow' as const,
} as const

export type ThemeColor = (typeof theme)[keyof typeof theme]

/** 压力级别 → 颜色 */
export function pressureColor(pressure: 'low' | 'medium' | 'high' | 'critical'): string {
  switch (pressure) {
    case 'low':
      return theme.success
    case 'medium':
      return theme.primary
    case 'high':
      return theme.warn
    case 'critical':
      return theme.error
  }
}

/** 危险级别 → 颜色（与 main.ts 的 renderEvent 保持一致） */
export function dangerColor(level: 'low' | 'medium' | 'high' | 'critical'): string {
  switch (level) {
    case 'low':
      return theme.dim
    case 'medium':
      return theme.primary
    case 'high':
      return theme.warn
    case 'critical':
      return theme.error
  }
}

/** 审批提示符 */
export const approvalPrompt = chalk.yellow

/** 横幅（REPL 启动时显示） */
export function banner(): string {
  return chalk.cyan('dev-assistant') + chalk.gray('（交互模式）· 输入 /help 查看命令，/quit 退出')
}
