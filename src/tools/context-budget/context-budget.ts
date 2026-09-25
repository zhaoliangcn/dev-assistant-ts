import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'

/**
 * context_budget：查询当前上下文预算状态。
 * 返回 token 占用、压力级别、消息数、工具 schema 开销。
 */

export const contextBudgetSpec: ToolSpec = {
  name: 'context_budget',
  description:
    '查询当前上下文预算：已用/总 token、占用比、压力级别（low/medium/high/critical）、消息条数。',
  parameters: {
    type: 'object',
    properties: {},
  },
  dangerLevel: 'low',
}

export const contextBudgetHandler: ToolHandler = async (_args, ctx) => {
  const agent = ctx.agent
  if (!agent) {
    return fail('context_budget 只能在 Agent 运行上下文中使用')
  }

  const context = agent.getContext()
  const budget = context.budget()
  const messages = context.toMessages()
  const byRole = countByRole(messages)

  const lines = [
    `上下文预算: ${budget.current} / ${budget.max} tokens（${(budget.ratio * 100).toFixed(1)}%）`,
    `压力级别: ${budget.pressure}`,
    `消息总数: ${messages.length}`,
    `角色分布: system=${byRole.system} user=${byRole.user} assistant=${byRole.assistant} tool=${byRole.tool}`,
    `输出预留: ${budget.reservedForOutput} tokens`,
  ]
  if (budget.pressure === 'high' || budget.pressure === 'critical') {
    lines.push('提示: 上下文接近上限，可考虑调用 compress_context 压缩或尽快 finish。')
  }

  return ok(lines.join('\n'))
}

function countByRole(
  messages: Array<{ role: string }>,
): { system: number; user: number; assistant: number; tool: number } {
  const c = { system: 0, user: 0, assistant: 0, tool: 0 }
  for (const m of messages) {
    if (m.role in c) c[m.role as keyof typeof c]++
  }
  return c
}

function ok(content: string) {
  return { success: true as const, content, restartRequested: false as const }
}
function fail(message: string) {
  return {
    success: false as const,
    content: message,
    restartRequested: false as const,
    errorCategory: 'permanent' as const,
  }
}
