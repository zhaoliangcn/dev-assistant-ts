import path from 'node:path'

/**
 * 文件工具共享辅助。
 */

/** 把相对路径解析到 workingDir（绝对路径原样用） */
export function resolveInWorkDir(workingDir: string, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(workingDir, p)
}

/** 截断过长的输出（工具结果回传给 LLM 时控制 token） */
export function truncateOutput(text: string, maxChars: number, hint = '（输出过长，已截断）'): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.7)
  const tail = maxChars - head - 120
  return `${text.slice(0, head)}\n…${hint}…\n${text.slice(-tail)}`
}

/** 简单二进制检测：前 8000 字节含 NUL 即视为二进制 */
export function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/** 行号前缀格式：`  12\t内容`（1 基，右对齐 6 位） */
export function withLineNumbers(content: string, startLine: number): string {
  const lines = content.split('\n')
  return lines
    .map((l, i) => `${String(startLine + i).padStart(6)}\t${l}`)
    .join('\n')
}
