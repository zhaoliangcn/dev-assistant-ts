import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'

/**
 * run_hook：手动执行一个已注册的 hook。
 * 通过 ToolContext.hooks（HookManager）执行；未注册该 hook 时报错。
 */

export const runHookSpec: ToolSpec = {
  name: 'run_hook',
  description:
    '手动执行一个已注册的 hook（见 .dev-assistant-hooks.toml）。name 为 hook 名称。返回该 hook 的 stdout/stderr 与退出状态。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'hook 名称' },
    },
    required: ['name'],
  },
  dangerLevel: 'high',
  approvalType: 'session',
  approvalScope: 'command',
}

export const runHookHandler: ToolHandler = async (args, ctx) => {
  const name = argString(args.arguments, 'name')
  if (!name) {
    return fail('缺少参数 name')
  }
  const manager = ctx.hooks
  if (!manager || !manager.isEnabled()) {
    return fail('hook 系统未启用（--no-hooks 或未配置）')
  }

  const hook = manager.list().find((h) => h.name === name)
  if (!hook) {
    const available = manager.list().map((h) => h.name).join(', ') || '（无）'
    return fail(`hook "${name}" 未注册。可用 hook: ${available}`)
  }

  // 临时构造一次 fire：复用 manager 的执行路径
  const results = await manager.fire(hook.event, {
    cwd: ctx.workingDir,
    sessionId: ctx.sessionId,
    tool: hook.tool,
  })
  const r = results.find((x) => x.name === name)
  if (!r) {
    return fail(`hook "${name}" 执行无结果（可能被过滤）`)
  }

  const parts = [`hook: ${r.name}`, `状态: ${r.success ? '成功' : `失败${r.timedOut ? '（超时）' : ''}`}`]
  if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout}`)
  if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr}`)
  parts.push(`耗时: ${r.durationMs}ms`)

  return {
    success: r.success,
    content: parts.join('\n'),
    restartRequested: false,
    errorCategory: r.success ? undefined : 'permanent',
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
