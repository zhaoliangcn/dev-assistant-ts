import { stat } from 'node:fs/promises'
import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString, argStringArray } from '../common.js'
import { resolveInWorkDir, looksBinary, truncateOutput, withLineNumbers } from './common.js'

/**
 * batch_read_files：批量读取多个文件（带行号）。
 * 每个文件默认最多 800 行，总输出截断到 150KB。
 */

const PER_FILE_MAX_LINES = 800
const MAX_OUTPUT_CHARS = 150_000
const MAX_FILE_BYTES = 2 * 1024 * 1024

export const batchReadFilesSpec: ToolSpec = {
  name: 'batch_read_files',
  description:
    '批量读取多个文件（每个文件带行号，默认每文件最多 800 行）。paths 为文件路径列表。',
  parameters: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: '文件路径列表' },
    },
    required: ['paths'],
  },
  dangerLevel: 'low',
}

export const batchReadFilesHandler: ToolHandler = async (args, ctx) => {
  const paths = argStringArray(args.arguments, 'paths') ?? (argString(args.arguments, 'path') ? [argString(args.arguments, 'path')!] : undefined)
  if (!paths || paths.length === 0) return fail('缺少参数 paths（文件路径数组）')
  if (paths.length > 20) return fail(`一次最多读取 20 个文件（当前 ${paths.length}）`)

  const sections: string[] = []
  let totalChars = 0
  let readCount = 0

  for (const raw of paths) {
    const filePath = resolveInWorkDir(ctx.workingDir, raw)
    let st
    try {
      st = await stat(filePath)
    } catch {
      sections.push(`### ${raw}\n（文件不存在）`)
      continue
    }
    if (!st.isFile()) {
      sections.push(`### ${raw}\n（不是文件）`)
      continue
    }
    if (st.size > MAX_FILE_BYTES) {
      sections.push(`### ${raw}\n（文件过大 ${st.size} 字节，请用 read_file 分段读取）`)
      continue
    }

    const { content } = await ctx.cache.readCached(filePath)
    if (looksBinary(Buffer.from(content.slice(0, 8000), 'utf8'))) {
      sections.push(`### ${raw}\n（二进制文件，跳过）`)
      continue
    }

    const lines = content.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const slice = lines.slice(0, PER_FILE_MAX_LINES).join('\n')
    const numbered = withLineNumbers(slice, 1)
    const more = lines.length > PER_FILE_MAX_LINES ? `\n…（共 ${lines.length} 行，仅显示前 ${PER_FILE_MAX_LINES}）` : ''
    const section = `### ${raw}\n${numbered}${more}`
    sections.push(section)
    totalChars += section.length
    readCount++

    if (totalChars > MAX_OUTPUT_CHARS) {
      sections.push('…（总输出过长，后续文件已省略，请减少文件数或单独读取）')
      break
    }
  }

  if (readCount === 0) return fail('没有成功读取任何文件')
  return ok(truncateOutput(sections.join('\n\n---\n\n'), MAX_OUTPUT_CHARS))
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
