import chalk from 'chalk'
import type { App } from './app.js'
import { getReadline, promptText, closeReadline } from './utils/prompt.js'
import { log } from './utils/logger.js'

/**
 * 交互 REPL（Phase 2 纯文本版；Phase 3 迁移 ink 组件化渲染）。
 *
 * 输入协议：
 * - 普通文本：作为用户消息发给 Agent
 * - /quit | /exit | /q：退出
 * - /status：显示当前状态（会话 id、工具列表、审批状态）
 * - /tools：列出已注册工具
 * - /approval：显示审批开关状态
 */

const BANNER = `
${chalk.cyan('dev-assistant')} ${chalk.dim('(交互模式)')}
输入消息与 Agent 对话；${chalk.dim('/status')} 查看状态，${chalk.dim('/quit')} 退出
`

export async function runRepl(app: App): Promise<void> {
  process.stdout.write(BANNER)
  const rl = getReadline()

  try {
    for (;;) {
      const line = await promptText(chalk.green('你 › '))
      const input = line.trim()
      if (!input) continue

      if (input === '/quit' || input === '/exit' || input === '/q') {
        process.stdout.write(chalk.dim('再见 👋\n'))
        break
      }

      if (input === '/status') {
        process.stdout.write(statusText(app))
        continue
      }
      if (input === '/tools') {
        const names = app.tools.listNames().join(', ')
        process.stdout.write(chalk.dim(`已注册工具（${app.tools.listNames().length}）: ${names}\n`))
        continue
      }
      if (input === '/approval') {
        process.stdout.write(
          chalk.dim(`审批: ${app.approval.isDisabled() ? chalk.red('已关闭（--no-approval）') : chalk.green('已启用')}\n`),
        )
        continue
      }

      if (input.startsWith('/')) {
        process.stdout.write(chalk.dim(`未知命令: ${input}（可用 /status /tools /approval /quit）\n`))
        continue
      }

      // 发送用户消息
      try {
        const result = await app.run(input)
        process.stdout.write('\n')
        if (!result.success && result.message) {
          process.stdout.write(chalk.yellow(`⚠️ ${result.message}\n`))
        }
        log.debug('轮次完成', {
          success: result.success,
          finished: result.finished,
          iterations: result.iterations,
          usage: result.usage,
        })
      } catch (e) {
        process.stdout.write(chalk.red(`错误: ${e instanceof Error ? e.message : String(e)}\n`))
      }
    }
  } finally {
    rl.pause()
  }
}

function statusText(app: App): string {
  const lines = [
    chalk.dim('— 会话状态 —'),
    `  会话 ID:   ${app.sessionId}`,
    `  工作目录:  ${app.workingDir}`,
    `  审批:      ${app.approval.isDisabled() ? '关闭' : '启用'}`,
    `  hooks:     ${app.hooks.isEnabled() ? `启用（${app.hooks.list().length} 个）` : '禁用'}`,
    `  工具数:    ${app.tools.listNames().length}`,
    chalk.dim('— 结束 —'),
  ]
  return `${lines.join('\n')}\n`
}

/** 供 main.ts 退出时调用（释放 readline） */
export function teardownRepl(): void {
  closeReadline()
}
