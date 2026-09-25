import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import path from 'node:path'
import { log } from '../utils/logger.js'

/**
 * 长期记忆（对齐设计文档 3.x memory.ts + Phase 4 KB 之前的简化版）。
 *
 * 存储：项目目录 `.dev-assistant-memory.json`
 *   { "entries": [ { "id": "...", "content": "...", "createdAt": ISO } ] }
 *
 * - 会话启动时 loadAll() 注入系统提示词（prompt.ts 的 memory 段）
 * - 条目上限 MAX_ENTRIES（默认 50），超出时淘汰最旧
 * - 单条上限 500 字符（防止记忆膨胀）
 */

const DEFAULT_MEMORY_FILE = '.dev-assistant-memory.json'
const MAX_ENTRIES = 50
const MAX_ENTRY_CHARS = 500

export interface MemoryEntry {
  id: string
  content: string
  createdAt: string
}

interface MemoryFile {
  entries: MemoryEntry[]
}

export class Memory {
  private entries: MemoryEntry[] = []
  private file: string

  constructor(workingDir: string, memoryFile?: string) {
    this.file = path.resolve(workingDir, memoryFile ?? DEFAULT_MEMORY_FILE)
  }

  /** 加载记忆（文件不存在返回空列表） */
  async load(): Promise<void> {
    try {
      await access(this.file)
    } catch {
      this.entries = []
      return
    }
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text) as MemoryFile
      if (parsed && Array.isArray(parsed.entries)) {
        this.entries = parsed.entries.filter(
          (e): e is MemoryEntry => e && typeof e.id === 'string' && typeof e.content === 'string',
        )
      } else {
        this.entries = []
      }
    } catch (e) {
      log.warn(`记忆文件损坏，重置为空: ${this.file}`, { error: e instanceof Error ? e.message : String(e) })
      this.entries = []
    }
  }

  /** 新增一条记忆（去重 + 上限淘汰） */
  async add(content: string): Promise<MemoryEntry> {
    const trimmed = content.trim().slice(0, MAX_ENTRY_CHARS)
    if (!trimmed) throw new Error('记忆内容不能为空')

    // 去重：内容完全相同的不重复添加
    const existing = this.entries.find((e) => e.content === trimmed)
    if (existing) return existing

    const entry: MemoryEntry = {
      id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      content: trimmed,
      createdAt: new Date().toISOString(),
    }
    this.entries.push(entry)
    // 上限淘汰最旧
    while (this.entries.length > MAX_ENTRIES) {
      this.entries.shift()
    }
    await this.persist()
    return entry
  }

  /** 按关键词查询（大小写不敏感子串匹配） */
  query(keyword: string): MemoryEntry[] {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return [...this.entries]
    return this.entries.filter((e) => e.content.toLowerCase().includes(kw))
  }

  /** 全部条目 */
  all(): MemoryEntry[] {
    return [...this.entries]
  }

  get size(): number {
    return this.entries.length
  }

  get filePath(): string {
    return this.file
  }

  /** 渲染为系统提示词注入段（无记忆返回 undefined） */
  toPromptSection(): string | undefined {
    if (this.entries.length === 0) return undefined
    const lines = this.entries.map((e) => `- ${e.content}`)
    return lines.join('\n')
  }

  /** 删除条目（返回是否删除成功） */
  async remove(id: string): Promise<boolean> {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.id !== id)
    if (this.entries.length === before) return false
    await this.persist()
    return true
  }

  /** 清空 */
  async clear(): Promise<void> {
    this.entries = []
    await this.persist()
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const data: MemoryFile = { entries: this.entries }
    await writeFile(this.file, JSON.stringify(data, null, 2), 'utf8')
  }
}
