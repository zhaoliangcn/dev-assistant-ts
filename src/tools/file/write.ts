import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'
import { atomicWrite } from '../../utils/atomic-write.js'
import { resolveInWorkDir } from './common.js'

/**
 * write_file：写入/覆盖文件（原子写入：临时文件 + rename）。
 * 自动创建父目录。写后使 ReadCache 中该文件失效。
 */

export const writeFileSpec: ToolSpec = {
  name: 'write_file',
  description: '写入/覆盖整个文件（原子写入，自动创建父目录）。用于新建文件或完整重写。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
  dangerLevel: 'high',
  approvalType: 'session',
  approvalScope: 'file',
}

export const writeFileHandler: ToolHandler = async (args, ctx) => {
  const rawPath = argString(args.arguments, 'path')
  const content = args.arguments.content
  if (!rawPath) return fail('缺少参数 path')
  if (typeof content !== 'string') return fail('缺少参数 content（字符串）')

  const filePath = resolveInWorkDir(ctx.workingDir, rawPath)
  try {
    await atomicWrite(filePath, content)
  } catch (e) {
    return fail(`写入失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  ctx.cache.invalidate(filePath)

  const lines = content.split('\n').length
  return ok(`已写入 ${rawPath}（${content.length} 字符 / ${lines} 行）`)
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
