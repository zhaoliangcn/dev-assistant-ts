import path from 'node:path'
import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString } from '../common.js'
import { resolveInWorkDir, withLineNumbers, truncateOutput } from './common.js'

/**
 * read_symbol：读取单个符号的完整定义（启发式解析）。
 *
 * 设计文档决策 2：Phase 1-4 用"正则 + 缩进启发式"，Phase 5 再评估 tree-sitter/ts-morph。
 *
 * 策略：
 * 1. 在文件中定位符号声明行（fn/function/class/struct/const/enum/interface/export 等模式）
 * 2. 按大括号配平 + 缩进回退判定符号体结束行
 * 3. 返回带行号的完整定义
 *
 * 局限：不处理宏、多行签名、嵌套模板字符串中的大括号（启发式，覆盖常见 TS/JS/Python/Rust 结构）。
 */

const MAX_OUTPUT_CHARS = 60_000
const MAX_SCAN_LINES = 20_000

/** 声明模式：语言前缀 + 符号名 */
const DECL_PATTERNS: RegExp[] = [
  // TS/JS
  /export\s+(default\s+)?(async\s+)?function\s*\*?\s*NAME\b/,
  /export\s+(default\s+)?class\s+NAME\b/,
  /export\s+(const|let|var)\s+NAME\s*[:=]/,
  /export\s+(abstract\s+)?class\s+NAME\b/,
  /export\s+(interface|type|enum)\s+NAME\b/,
  /(?:^|\n)(?:export\s+)?(async\s+)?function\s*\*?\s*NAME\b/,
  /(?:^|\n)(?:export\s+)?class\s+NAME\b/,
  /(?:^|\n)(?:export\s+)?(?:abstract\s+)?class\s+NAME\b/,
  /(?:^|\n)(?:export\s+)?(interface|type|enum)\s+NAME\b/,
  // TS/JS 对象方法 / 类方法
  /(?:^|\n)\s*(?:async\s+)?NAME\s*\([^)]*\)\s*\{/,
  // Rust
  /(?:^|\n)(pub\s+)?(?:async\s+)?fn\s+NAME\b/,
  /(?:^|\n)(pub\s+)?(struct|enum|trait|type)\s+NAME\b/,
  // Python
  /(?:^|\n)(?:async\s+)?def\s+NAME\s*\(/,
  /(?:^|\n)class\s+NAME\s*\(/,
  /(?:^|\n)class\s+NAME\b/,
  // Go
  /(?:^|\n)func\s+(?:\([^)]*\)\s*)?NAME\s*\(/,
  // Java/C#
  /(?:^|\n)\s*(?:public|private|protected|internal|static|abstract|final|\s)*\s*[\w<>[\],\s]+?\s+NAME\s*\([^;{]*\)\s*\{/,
]

export const readSymbolSpec: ToolSpec = {
  name: 'read_symbol',
  description:
    '读取文件中某个符号（函数/类/方法/常量）的完整定义。参数：path（文件）、symbol（符号名）。启发式解析（大括号配平 + 缩进），覆盖 TS/JS/Python/Rust/Go 常见声明。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      symbol: { type: 'string', description: '符号名（函数/类/方法/常量名）' },
    },
    required: ['path', 'symbol'],
  },
  dangerLevel: 'low',
}

export const readSymbolHandler: ToolHandler = async (args, ctx) => {
  const rawPath = argString(args.arguments, 'path')
  const symbol = argString(args.arguments, 'symbol')
  if (!rawPath) return fail('缺少参数 path')
  if (!symbol) return fail('缺少参数 symbol')
  if (!/^[\w$]+$/.test(symbol)) return fail(`symbol 名非法（只允许字母数字下划线 $）: ${symbol}`)

  const filePath = resolveInWorkDir(ctx.workingDir, rawPath)
  let content: string
  try {
    const { content: c } = await ctx.cache.readCached(filePath)
    content = c
  } catch {
    return fail(`文件不存在: ${rawPath}`)
  }

  const lines = content.split('\n')
  const declLine = findDeclarationLine(lines, symbol)
  if (declLine === -1) {
    return fail(`未在 ${rawPath} 中找到符号 "${symbol}" 的声明（启发式匹配，多行签名/宏可能漏配）`)
  }

  const endLine = findSymbolEnd(lines, declLine)
  const slice = lines.slice(declLine, endLine + 1).join('\n')
  const numbered = withLineNumbers(slice, declLine + 1)
  const header = `符号 ${symbol}（${path.basename(rawPath)}，第 ${declLine + 1}-${endLine + 1} 行）:`
  return ok(truncateOutput(`${header}\n${numbered}`, MAX_OUTPUT_CHARS))
}

/** 定位符号声明行（0 基）；未找到返回 -1 */
function findDeclarationLine(lines: string[], symbol: string): number {
  const name = symbol.replace(/[$]/g, '\\$')
  const patterns = DECL_PATTERNS.map((re) => new RegExp(re.source.replace(/NAME/g, name)))
  const limit = Math.min(lines.length, MAX_SCAN_LINES)

  // 第一遍：优先精确匹配"声明关键字 + 名字"
  for (let i = 0; i < limit; i++) {
    const line = lines[i] ?? ''
    for (const re of patterns) {
      if (re.test(line)) return i
    }
  }
  return -1
}

/**
 * 从声明行开始，用大括号配平 + 缩进回退找符号结束行（0 基，含结尾行）。
 * 启发式规则：
 * - 跟踪 { } 深度（忽略字符串/注释中的大括号做粗略处理）
 * - 深度归零且已开过括号 → 结束
 * - 无括号符号（如 Python def 的最后一行 / const 单行）：按后续缩进不更深判定
 */
function findSymbolEnd(lines: string[], start: number): number {
  const limit = Math.min(lines.length, start + 5000)
  const startIndent = indentOf(lines[start] ?? '')

  // 单行完整符号：声明行自带闭合大括号
  if (bracketBalance(lines[start] ?? '') === 0 && /\}\s*$/.test(lines[start] ?? '')) {
    return start
  }

  let depth = 0
  let opened = false
  for (let i = start; i < limit; i++) {
    const line = lines[i] ?? ''
    const balanced = bracketBalance(line)
    if (balanced > 0) opened = true
    depth += balanced
    if (opened && depth <= 0) {
      // 找到闭合行；再包含紧随的 "}" 之后的装饰行（如 JSDoc 尾）不多要
      return i
    }
    // 无括号符号（Python def / 单行 const）：下一行缩进回退到不深于声明行 → 结束
    if (!opened && i > start) {
      const indent = indentOf(line)
      if (line.trim() !== '' && indent <= startIndent) {
        return i - 1
      }
    }
  }
  return Math.min(limit - 1, lines.length - 1)
}

/** 一行内大括号净深度（粗略忽略字符串与注释内容） */
function bracketBalance(line: string): number {
  let depth = 0
  let inS: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inS) {
      if (ch === inS && line[i - 1] !== '\\') inS = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inS = ch
      continue
    }
    if (ch === '/' && line[i + 1] === '/') break // 行注释
    if (ch === '{') depth++
    else if (ch === '}') depth--
  }
  return depth
}

function indentOf(line: string): number {
  const m = line.match(/^\s*/)
  return m ? m[0].length : 0
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
