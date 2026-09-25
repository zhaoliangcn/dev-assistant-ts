import fg from 'fast-glob'
import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString, argStringArray } from '../common.js'
import { resolveInWorkDir } from './common.js'

/**
 * glob：按 glob 模式匹配文件（尊重 .gitignore 语义：忽略 node_modules/dist 等）。
 * 支持单个或多个模式（数组 / 逗号分隔字符串）。
 */

export const globSpec: ToolSpec = {
  name: 'glob',
  description:
    '按 glob 模式查找文件（如 **/*.ts、src/**/*.test.ts）。可用 patterns 传多个模式。自动忽略 node_modules、dist、.git 等构建/VCS 目录。返回相对路径列表（按修改时间倒序，最多 500 条）。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式（单模式）' },
      patterns: { type: 'array', items: { type: 'string' }, description: 'glob 模式列表（多模式）' },
      cwd: { type: 'string', description: '搜索根目录（默认工作目录）' },
    },
  },
  dangerLevel: 'low',
}

const IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/target/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.dev-assistant-store/**',
]

export const globHandler: ToolHandler = async (args, ctx) => {
  const patterns =
    argStringArray(args.arguments, 'patterns') ?? (argString(args.arguments, 'pattern') ? [argString(args.arguments, 'pattern')!] : undefined)
  if (!patterns || patterns.length === 0) return fail('缺少参数 pattern 或 patterns')

  const searchRoot = argString(args.arguments, 'cwd')
    ? resolveInWorkDir(ctx.workingDir, argString(args.arguments, 'cwd')!)
    : ctx.workingDir

  try {
    const results = await fg(patterns, {
      cwd: searchRoot,
      ignore: IGNORED,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
    })
    if (results.length === 0) {
      return ok(`没有匹配文件（模式: ${patterns.join(', ')}）`)
    }
    const shown = results.slice(0, 500)
    const more = results.length > 500 ? `\n…（共 ${results.length} 条，仅显示前 500）` : ''
    return ok(shown.map((p) => p.replace(/\\/g, '/')).join('\n') + more)
  } catch (e) {
    return fail(`glob 执行失败: ${e instanceof Error ? e.message : String(e)}`)
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
