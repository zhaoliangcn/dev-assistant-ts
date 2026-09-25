import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argNumber, argString } from '../common.js'
import { resolveInWorkDir } from './common.js'

/**
 * list_directory：列目录树（缩进，目录以 / 结尾）。
 * - depth: 最大递归深度（默认 2，上限 5）
 * - 跳过 node_modules / .git / dist 等
 */

export const listDirectorySpec: ToolSpec = {
  name: 'list_directory',
  description: '列出目录内容（树形缩进，目录以 / 结尾）。可选 path（默认工作目录）与 depth（递归深度，默认 2，上限 5）。自动跳过 node_modules/.git/dist 等。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径（默认工作目录）' },
      depth: { type: 'integer', description: '最大递归深度（默认 2，上限 5）' },
    },
  },
  dangerLevel: 'low',
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'target', 'build', 'out', 'coverage',
  '.next', '.venv', 'venv', '__pycache__', '.dev-assistant-store', '.idea',
])

export const listDirectoryHandler: ToolHandler = async (args, ctx) => {
  const rawPath = argString(args.arguments, 'path') ?? '.'
  const depth = Math.min(5, Math.max(1, argNumber(args.arguments, 'depth') ?? 2))
  const rootDir = resolveInWorkDir(ctx.workingDir, rawPath)

  let rootStat
  try {
    rootStat = await stat(rootDir)
  } catch {
    return fail(`目录不存在: ${rawPath}`)
  }
  if (!rootStat.isDirectory()) {
    return fail(`不是目录: ${rawPath}`)
  }

  const lines: string[] = []
  let count = 0
  const MAX_ENTRIES = 2000

  async function walk(dir: string, indent: string, remaining: number): Promise<void> {
    if (count >= MAX_ENTRIES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    // 目录在前，字母序
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const entry of entries) {
      if (count >= MAX_ENTRIES) {
        lines.push(`${indent}…（条目过多，已截断）`)
        return
      }
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`)
        count++
        if (remaining > 0) await walk(full, `${indent}  `, remaining - 1)
      } else if (entry.isFile()) {
        lines.push(`${indent}${entry.name}`)
        count++
      }
    }
  }

  await walk(rootDir, '', depth)

  if (lines.length === 0) {
    return ok(`（空目录）${rawPath}`)
  }
  return ok(`目录树 ${rawPath}（深度 ${depth}，共 ${count} 项）:\n${lines.join('\n')}`)
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
