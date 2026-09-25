import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'
import { createTaskManager } from './task-manager.js'
import type { TaskRecord } from './task-manager.js'

/**
 * task_status：查询任务状态（对齐设计文档 6.6）。
 * 无 id 参数 → 列出最近任务；有 id → 查单个任务详情。
 */

export const taskStatusSpec: ToolSpec = {
  name: 'task_status',
  description:
    '查询任务状态。不传 id 时列出最近任务（含运行中/暂停/已完成/已取消）；传 id 时返回单个任务详情。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '任务 id（可选；缺省列出最近任务）' },
    },
  },
  dangerLevel: 'low',
}

export const taskStatusHandler: ToolHandler = async (args, ctx) => {
  const id = argString(args.arguments, 'id')
  const tm = createTaskManager(ctx.workingDir)

  try {
    if (id) {
      const task = await tm.get(id)
      if (!task) return fail(`未找到任务 ${id}`)
      return ok(renderTask(task))
    }
    const tasks = await tm.list()
    if (tasks.length === 0) return ok('当前没有任何任务记录。')
    const running = tasks.filter((t) => t.status === 'running').length
    return ok(`共 ${tasks.length} 条任务记录（运行中 ${running}）:\n\n${tasks.map(renderTask).join('\n\n')}`)
  } catch (e) {
    return fail(`任务状态查询失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function renderTask(task: TaskRecord): string {
  const lines = [
    `- id: ${task.id}`,
    `- 描述: ${task.description}`,
    `- 状态: ${task.status}`,
    `- 创建: ${task.createdAt} · 更新: ${task.updatedAt}`,
    `- 迭代: ${task.iterations} 轮`,
  ]
  if (task.note) lines.push(`- 备注: ${task.note}`)
  return lines.join('\n')
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
