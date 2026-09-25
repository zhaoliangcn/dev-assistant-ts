import chalk from 'chalk'
import type { AgentEvent } from '../agent/agent.js'
import { theme, dangerColor } from './theme.js'

/**
 * 纯文本渲染工具（非 TTY / --message 模式下的流式输出）。
 * ink 组件用于 TTY 交互模式；此处的 chalk 渲染用于降级与一次性执行。
 */

/** 渲染一个 AgentEvent 到 stdout（纯文本/chalk） */
export function renderAgentEvent(event: AgentEvent): void {
  switch (event.kind) {
    case 'assistantStreamDelta':
      process.stdout.write(event.content)
      break
    case 'reasoningDelta':
      process.stdout.write(chalk.dim(event.content))
      break
    case 'toolCall': {
      const args = previewArgs(event.call.function.arguments)
      const level = event.security?.dangerLevel ?? 'low'
      const levelLabel = `[${level}]`
      process.stdout.write(
        `\n${chalk.magenta('🔧 ')}${chalk.cyan(event.call.function.name)} ${chalk.dim(args)} ${chalk[dangerColor(level) as 'cyan'](levelLabel)}`,
      )
      break
    }
    case 'toolResult': {
      const mark = event.result.success ? chalk.green('✓') : chalk.red('✗')
      const preview = event.result.content.replace(/\n/g, ' ⏎ ').slice(0, 200)
      process.stdout.write(`${mark} ${chalk.dim(preview)}`)
      break
    }
    case 'status':
      process.stdout.write(chalk.dim(`\n⏳ ${event.content}`))
      break
    case 'systemMessage':
      process.stdout.write(chalk.dim(`\n[hooks] ${event.content}`))
      break
    case 'tokenUsage':
      // 静默（debug 日志已覆盖）
      break
  }
}

function previewArgs(argsJson: string): string {
  return argsJson.length > 100 ? `${argsJson.slice(0, 100)}…` : argsJson
}

/** 压力百分比条（状态栏用） */
export function pressureBar(ratio: number, width = 10): string {
  const filled = Math.min(width, Math.round(ratio * width))
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  return `${bar} ${(ratio * 100).toFixed(0)}%`
}

export { theme }
