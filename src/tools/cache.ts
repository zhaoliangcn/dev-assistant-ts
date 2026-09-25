import { readFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import type { TokenUsage } from '../llm/models.js'

/**
 * ReadCache：文件读取缓存。
 * 用途：
 * 1. 同一会话内重复 read_file 时返回缓存（附提示），减少 IO 与 token
 * 2. edit_file 校验 mtime/hash 是否变化，防止基于过期内容编辑
 *
 * 对齐 Rust 版 `tools/cache.rs`。
 */

export interface CachedFile {
  path: string
  content: string
  /** 读取时的 mtime（ms） */
  mtimeMs: number
  /** 读取时的字节大小 */
  size: number
}

export class ReadCache {
  private files = new Map<string, CachedFile>()

  /** 记录一次读取 */
  put(path: string, content: string, mtimeMs: number, size: number): void {
    this.files.set(path, { path, content, mtimeMs, size })
  }

  get(path: string): CachedFile | undefined {
    return this.files.get(path)
  }

  /** 缓存是否仍然有效（文件未变化） */
  async isFresh(path: string): Promise<boolean> {
    const cached = this.files.get(path)
    if (!cached) return false
    try {
      const st = await stat(path)
      return st.mtimeMs === cached.mtimeMs && st.size === cached.size
    } catch {
      return false // 文件消失
    }
  }

  /** 失效（写操作后调用） */
  invalidate(path: string): void {
    this.files.delete(path)
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) this.files.delete(key)
    }
  }

  size(): number {
    return this.files.size
  }

  clear(): void {
    this.files.clear()
  }

  /** 带缓存的读取：命中且未变化则直接返回 */
  async readCached(path: string): Promise<{ content: string; cached: boolean }> {
    const cached = this.files.get(path)
    if (cached && (await this.isFresh(path))) {
      return { content: cached.content, cached: true }
    }
    const content = await readFile(path, 'utf8')
    const st = await stat(path)
    this.put(path, content, st.mtimeMs, st.size)
    return { content, cached: false }
  }
}

/** token 用量累加器（Agent 维护跨轮总用量） */
export class UsageAccumulator {
  promptTokens = 0
  completionTokens = 0
  totalTokens = 0

  add(u: TokenUsage): void {
    this.promptTokens += u.promptTokens
    this.completionTokens += u.completionTokens
    this.totalTokens += u.totalTokens
  }

  snapshot(): TokenUsage {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
    }
  }
}
