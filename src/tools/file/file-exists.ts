import { stat } from 'node:fs/promises'
import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'
import { resolveInWorkDir } from './common.js'

/**
 * file_exists：检查文件/目录是否存在。
 */

export const fileExistsSpec: ToolSpec = {
  name: 'file_exists',
  description: '检查文件或目录是否存在，并返回类型（file/directory）与大小。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '路径' },
    },
    required: ['path'],
  },
  dangerLevel: 'low',
}

export const fileExistsHandler: ToolHandler = async (args, ctx) => {
  const rawPath = argString(args.arguments, 'path')
  if (!rawPath) return fail('缺少参数 path')
  const filePath = resolveInWorkDir(ctx.workingDir, rawPath)
  try {
    const st = await stat(filePath)
    const kind = st.isDirectory() ? 'directory' : 'file'
    return ok(`存在: ${rawPath}（${kind}，${st.size} 字节）`)
  } catch {
    return ok(`不存在: ${rawPath}`)
  }
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
