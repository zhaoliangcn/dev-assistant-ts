import fs from 'node:fs'
import path from 'node:path'

/**
 * 文件工具共享辅助。
 */

/** 判断 resolved 是否位于 root 内（win32 大小写不敏感） */
export function isInsideWorkDir(root: string, resolved: string): boolean {
  const lc = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const nRoot = lc(path.resolve(root)).replace(/[\\/]+$/, '')
  const nResolved = lc(path.resolve(resolved))
  return nResolved === nRoot || nResolved.startsWith(nRoot + path.sep)
}

/**
 * 把路径解析并收敛到 workingDir 内（文件工具的路径围栏）。
 *
 * 绝对路径仅当解析后仍落在 workingDir 内时放行（允许工具结果里回传的
 * 绝对路径被正常往返使用）；`..` 穿越、其他盘符、盘相对路径（如 `C:foo`）、
 * UNC 一律抛错——文件工具是模型能力的围栏，模型输出不可信。
 * 已存在的路径会做 realpath 二次校验，拦截 workingDir 内符号链接指向外部的逃逸。
 *
 * 抛错由 registry.execute 统一包装为失败 ToolResult（errorCategory: permanent）。
 */
export function resolveInWorkDir(workingDir: string, p: string): string {
  if (typeof p !== 'string' || p.trim().length === 0) {
    throw new Error('路径参数不能为空')
  }
  const root = path.resolve(workingDir)
  const resolved = path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p)

  // 词法校验（拦 ../ 与盘符切换）+ realpath 校验（拦符号链接逃逸；路径尚不存在时跳过）
  if (!isInsideWorkDir(root, resolved)) {
    throw new Error(`路径越界: ${p} 不在工作目录 ${root} 内（文件工具仅允许访问工作目录之内）`)
  }
  try {
    const realRoot = fs.realpathSync(root)
    const realResolved = fs.realpathSync(resolved)
    if (!isInsideWorkDir(realRoot, realResolved)) {
      throw new Error(`路径越界: ${p}（经符号链接解析后指向工作目录之外）`)
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('路径越界')) throw e
    // ENOENT 等：新建文件的路径尚不存在，词法校验已通过即可
  }
  return resolved
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
