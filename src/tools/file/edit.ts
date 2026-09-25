import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'
import { atomicWrite } from '../../utils/atomic-write.js'
import { resolveInWorkDir } from './common.js'

/**
 * edit_file：精确片段替换（old_string → new_string）。
 * - old_string 必须在文件中**唯一**出现（replace_all=true 时除外）
 * - 未找到 / 多处匹配 → 失败并返回诊断（文件保持不变）
 * - 替换后失效 ReadCache
 */

export const editFileSpec: ToolSpec = {
  name: 'edit_file',
  description:
    '精确编辑：把文件中唯一匹配的 old_string 替换为 new_string。old_string 必须与文件内容完全一致（含空白/缩进）且唯一；replace_all=true 时替换所有匹配。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要替换的原文（必须精确且唯一）' },
      new_string: { type: 'string', description: '替换后的新文本' },
      replace_all: { type: 'boolean', description: '替换所有匹配（默认 false = 要求唯一）' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  dangerLevel: 'high',
  approvalType: 'session',
  approvalScope: 'file',
}

export const editFileHandler: ToolHandler = async (args, ctx) => {
  const rawPath = argString(args.arguments, 'path')
  const oldString = typeof args.arguments.old_string === 'string' ? args.arguments.old_string : undefined
  const newString = typeof args.arguments.new_string === 'string' ? args.arguments.new_string : undefined
  const replaceAll = args.arguments.replace_all === true

  if (!rawPath) return fail('缺少参数 path')
  if (oldString === undefined || oldString === '') return fail('缺少参数 old_string（不能为空）')
  if (newString === undefined) return fail('缺少参数 new_string（可为空字符串表示删除）')
  if (oldString === newString) return fail('old_string 与 new_string 相同，无需编辑')

  const filePath = resolveInWorkDir(ctx.workingDir, rawPath)

  // 从缓存读（新鲜才用），否则读盘
  let content: string
  const cachedEntry = ctx.cache.get(filePath)
  if (cachedEntry && (await ctx.cache.isFresh(filePath))) {
    content = cachedEntry.content
  } else {
    try {
      const { content: c } = await ctx.cache.readCached(filePath)
      content = c
    } catch {
      return fail(`文件不存在: ${rawPath}`)
    }
  }

  const occurrences = countOccurrences(content, oldString)
  if (occurrences === 0) {
    return fail(
      `old_string 在文件中未找到（请重新读取文件确认精确内容，注意空白与缩进）。提示: 前 80 字符 = ${JSON.stringify(oldString.slice(0, 80))}`,
    )
  }
  if (occurrences > 1 && !replaceAll) {
    return fail(`old_string 在文件中出现 ${occurrences} 次，不唯一。请增加上下文使其唯一，或设 replace_all=true。`)
  }

  let updated: string
  if (replaceAll) {
    updated = content.split(oldString).join(newString)
  } else {
    const idx = content.indexOf(oldString)
    updated = content.slice(0, idx) + newString + content.slice(idx + oldString.length)
  }

  try {
    await atomicWrite(filePath, updated)
  } catch (e) {
    return fail(`写入失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  ctx.cache.invalidate(filePath)

  return ok(`已编辑 ${rawPath}（替换 ${replaceAll ? occurrences : 1} 处）`)
}

/** 统计非重叠出现次数 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
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
