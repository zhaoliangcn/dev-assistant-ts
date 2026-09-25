import { stat } from 'node:fs/promises'
import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argNumber, argString } from '../common.js'
import { resolveInWorkDir, looksBinary, truncateOutput, withLineNumbers } from './common.js'

/**
 * read_file：读取文件内容，支持行号范围。
 * - offset: 1 基起始行（默认 1）
 * - limit:  最多行数（默认 1500）
 * - 输出带行号；二进制/超大文件给出诊断而非报错
 */

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5MB
const MAX_OUTPUT_CHARS = 150_000

export const readFileSpec: ToolSpec = {
  name: 'read_file',
  description:
    '读取文件内容（带行号）。可选 offset（1 基起始行，默认 1）与 limit（最多行数，默认 1500）。大文件请分段读取。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工作目录或绝对路径）' },
      offset: { type: 'integer', description: '起始行（1 基，默认 1）' },
      limit: { type: 'integer', description: '最多读取行数（默认 1500）' },
    },
    required: ['path'],
  },
  dangerLevel: 'low',
}

export const readFileHandler: ToolHandler = async (args, ctx) => {
  const rawPath = argString(args.arguments, 'path')
  if (!rawPath) {
    return fail('缺少参数 path')
  }
  const filePath = resolveInWorkDir(ctx.workingDir, rawPath)
  const offset = Math.max(1, argNumber(args.arguments, 'offset') ?? 1)
  const limit = Math.max(1, argNumber(args.arguments, 'limit') ?? 1500)

  let st
  try {
    st = await stat(filePath)
  } catch {
    return fail(`文件不存在: ${rawPath}`)
  }
  if (!st.isFile()) {
    return fail(`不是文件（是目录）: ${rawPath}`)
  }
  if (st.size > MAX_FILE_BYTES) {
    return fail(`文件过大（${st.size} 字节 > ${MAX_FILE_BYTES}），请用 offset/limit 分段读取或用 exec_command 查看` )
  }

  const { content, cached } = await ctx.cache.readCached(filePath)
  if (looksBinary(Buffer.from(content.slice(0, 8000), 'utf8'))) {
    return fail(`二进制文件，无法以文本读取: ${rawPath}`)
  }

  // 尾部换行会产生一个空元素，不计入总行数
  const allLines = content.split('\n')
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()
  const total = allLines.length
  const end = Math.min(total, offset + limit - 1)
  const slice = allLines.slice(offset - 1, end).join('\n')
  const numbered = withLineNumbers(slice, offset)

  const header: string[] = []
  if (cached) header.push('（缓存命中：文件自上次读取后未变化）')
  if (offset > 1 || end < total) header.push(`显示第 ${offset}-${end} 行 / 共 ${total} 行`)
  const body = truncateOutput(header.length > 0 ? `${header.join('\n')}\n${numbered}` : numbered, MAX_OUTPUT_CHARS)

  return ok(body)
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
