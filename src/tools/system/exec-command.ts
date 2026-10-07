import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString, argNumber, argBoolean } from '../common.js'
import { resolveInWorkDir } from '../file/common.js'
import { runShell } from '../../hooks/shell.js'

/**
 * exec_command：执行 shell 命令（danger=critical，每次需审批）。
 * - 默认超时 60s（timeout 参数覆盖，上限 300s）
 * - 输出截断（stdout 20KB / stderr 10KB）
 * - 退出码非 0 → success=false（但 content 含完整输出供 LLM 诊断）
 */

const DEFAULT_TIMEOUT_SECS = 60
const MAX_TIMEOUT_SECS = 300
const MAX_STDOUT = 20_000
const MAX_STDERR = 10_000

export const execCommandSpec: ToolSpec = {
  name: 'exec_command',
  description:
    '在工作目录执行 shell 命令（sh -c）。默认超时 60 秒（timeout 可覆盖，上限 300s）。退出码非 0 会标记失败但保留输出。需要用户审批。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      timeout: { type: 'integer', description: '超时秒数（默认 60，上限 300）' },
      cwd: { type: 'string', description: '工作目录（默认项目工作目录）' },
      allow_failure: { type: 'boolean', description: '为 true 时退出码非 0 也标记 success（输出仍完整返回）' },
    },
    required: ['command'],
  },
  dangerLevel: 'critical',
  approvalType: 'one-time',
  approvalScope: 'command',
}

export const execCommandHandler: ToolHandler = async (args, ctx) => {
  const command = argString(args.arguments, 'command')
  if (!command) return fail('缺少参数 command')

  const timeout = Math.min(
    MAX_TIMEOUT_SECS,
    Math.max(1, argNumber(args.arguments, 'timeout') ?? DEFAULT_TIMEOUT_SECS),
  )
  const allowFailure = argBoolean(args.arguments, 'allow_failure') ?? false
  const cwd = argString(args.arguments, 'cwd')
    ? resolveInWorkDir(ctx.workingDir, argString(args.arguments, 'cwd')!)
    : ctx.workingDir

  if (ctx.signal?.aborted) {
    return fail('命令执行被取消')
  }

  const r = await runShell({
    command,
    cwd,
    timeoutMs: timeout * 1000,
    signal: ctx.signal,
  })

  const stdout = r.stdout.length > MAX_STDOUT ? `${r.stdout.slice(0, MAX_STDOUT)}\n…(stdout 截断)` : r.stdout
  const stderr = r.stderr.length > MAX_STDERR ? `${r.stderr.slice(0, MAX_STDERR)}\n…(stderr 截断)` : r.stderr

  const parts: string[] = []
  parts.push(`命令: ${command}`)
  if (r.aborted) parts.push('（被取消）')
  if (r.timedOut) parts.push(`（超时 ${timeout}s）`)
  parts.push(`退出码: ${r.exitCode ?? 'N/A'}`)
  if (stdout.trim()) parts.push(`--- stdout ---\n${stdout}`)
  if (stderr.trim()) parts.push(`--- stderr ---\n${stderr}`)
  if (!stdout.trim() && !stderr.trim() && !r.timedOut) parts.push('（无输出）')

  const success = r.success || allowFailure
  return {
    success,
    content: parts.join('\n'),
    restartRequested: false,
    errorCategory: success ? undefined : 'permanent',
  }
}

function fail(message: string) {
  return {
    success: false as const,
    content: message,
    restartRequested: false as const,
    errorCategory: 'permanent' as const,
  }
}
