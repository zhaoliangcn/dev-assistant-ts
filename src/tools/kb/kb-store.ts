import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nowIso } from '../../persist/events.js'
import { log } from '../../utils/logger.js'

/**
 * 知识库存储（对齐设计文档 6.5 kb_store/kb_query）。
 *
 * 存储布局：项目目录 `.dev-assistant-kb/`
 *   <title-slug>.md     ← 每篇笔记一个 Markdown 文件
 *     frontmatter: title / tags / createdAt / updatedAt
 *     正文：笔记内容
 *
 * 查询：全库扫描，按 tags 精确匹配 + 正文/标题关键词子串打分（简单 BM25 风格：
 * 词频 × 逆文档频率近似），返回 top N。零新依赖，规模在百篇以内足够。
 */

const KB_DIR = '.dev-assistant-kb'
/** 正文最大长度（防止单篇笔记撑爆上下文） */
const MAX_NOTE_CHARS = 20_000

export interface KbNote {
  /** 笔记 id（文件名 stem，title 的 slug） */
  id: string
  title: string
  tags: string[]
  content: string
  createdAt: string
  updatedAt: string
  file: string
}

export class KbStore {
  private dir: string

  constructor(workingDir: string) {
    this.dir = path.resolve(workingDir, KB_DIR)
  }

  get dirPath(): string {
    return this.dir
  }

  private noteFile(id: string): string {
    return path.join(this.dir, `${id}.md`)
  }

  /** title → 安全文件名 slug */
  static slugify(title: string): string {
    const base = title
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
    return base || `note-${Date.now().toString(36)}`
  }

  /** 列出全部笔记（不读正文，仅 frontmatter + 正文长度） */
  async list(): Promise<Array<Pick<KbNote, 'id' | 'title' | 'tags' | 'createdAt' | 'updatedAt'>>> {
    let files: string[]
    try {
      files = await readdir(this.dir)
    } catch {
      return []
    }
    const notes: Array<Pick<KbNote, 'id' | 'title' | 'tags' | 'createdAt' | 'updatedAt'>> = []
    for (const f of files.sort()) {
      if (!f.endsWith('.md')) continue
      const note = await this.loadNote(f.slice(0, -3)).catch(() => null)
      if (note) {
        notes.push({ id: note.id, title: note.title, tags: note.tags, createdAt: note.createdAt, updatedAt: note.updatedAt })
      }
    }
    return notes
  }

  /** 读取一篇笔记（id 为文件名 stem） */
  async loadNote(id: string): Promise<KbNote> {
    const file = this.noteFile(id)
    const text = await readFile(file, 'utf8')
    const note = KbStore.parseNote(id, text)
    if (!note) throw new Error(`知识库笔记损坏: ${file}`)
    return note
  }

  /** 写入/覆盖一篇笔记，返回最终 id（title 冲突时追加 -2/-3…） */
  async put(title: string, content: string, tags: string[]): Promise<KbNote> {
    const trimmed = content.trim()
    if (!trimmed) throw new Error('笔记内容不能为空')
    if (!title.trim()) throw new Error('笔记标题不能为空')
    const body = trimmed.length > MAX_NOTE_CHARS ? `${trimmed.slice(0, MAX_NOTE_CHARS)}\n…（超长已截断）` : trimmed

    await mkdir(this.dir, { recursive: true })

    // 唯一 id：优先复用同 title 的已有笔记（覆盖更新）
    let id = KbStore.slugify(title)
    const existing = await this.list()
    const sameTitle = existing.find((n) => n.title === title.trim())
    if (sameTitle) {
      id = sameTitle.id
    } else while (await this.exists(id)) {
      id = `${id}-${Math.random().toString(36).slice(2, 6)}`
    }

    const now = nowIso()
    const prev = sameTitle ? (await this.loadNote(sameTitle.id).catch(() => null)) : null
    const note: KbNote = {
      id,
      title: title.trim(),
      tags: tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
      content: body,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      file: this.noteFile(id),
    }
    await writeFile(note.file, KbStore.renderNote(note), 'utf8')
    log.debug('知识库写入', { id, title: note.title, chars: body.length })
    return note
  }

  /** 删除笔记，返回是否删除成功 */
  async remove(id: string): Promise<boolean> {
    try {
      const { unlink } = await import('node:fs/promises')
      await unlink(this.noteFile(id))
      return true
    } catch {
      return false
    }
  }

  /** 查询：tags 过滤 + 关键词打分，返回 top N */
  async query(keywords: string[], tags: string[] = [], limit = 5): Promise<Array<{ note: KbNote; score: number }>> {
    const all = await this.list()
    if (all.length === 0) return []

    const kws = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean)
    const tagFilter = tags.map((t) => t.trim().toLowerCase()).filter(Boolean)

    // 全库加载（打分需要正文）
    const notes: KbNote[] = []
    for (const meta of all) {
      const n = await this.loadNote(meta.id).catch(() => null)
      if (n) notes.push(n)
    }
    if (notes.length === 0) return []

    // 逆文档频率近似：含该词文档数
    const docFreq = new Map<string, number>()
    for (const n of notes) {
      const text = `${n.title} ${n.content} ${n.tags.join(' ')}`.toLowerCase()
      for (const kw of kws) {
        if (text.includes(kw)) {
          docFreq.set(kw, (docFreq.get(kw) ?? 0) + 1)
        }
      }
    }

    const results: Array<{ note: KbNote; score: number }> = []
    for (const n of notes) {
      if (tagFilter.length > 0) {
        const ok = tagFilter.every((t) => n.tags.some((tag) => tag.includes(t)))
        if (!ok) continue
      }
      let score = 0
      for (const kw of kws) {
        const text = `${n.title} ${n.content}`.toLowerCase()
        let count = 0
        let idx = text.indexOf(kw)
        while (idx !== -1) {
          count++
          idx = text.indexOf(kw, idx + kw.length)
        }
        if (count > 0) {
          const idf = Math.log(1 + notes.length / (1 + (docFreq.get(kw) ?? 0)))
          score += (1 + Math.log(count)) * idf
        }
      }
      // 标题命中加权
      for (const kw of kws) {
        if (n.title.toLowerCase().includes(kw)) score += 2
      }
      if (score > 0 || (kws.length === 0 && tagFilter.length > 0)) {
        results.push({ note: n, score })
      }
    }

    results.sort((a, b) => b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt))
    return results.slice(0, limit)
  }

  private async exists(id: string): Promise<boolean> {
    try {
      await readFile(this.noteFile(id))
      return true
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------------
  // frontmatter 序列化（与 skills 同款简单格式）
  // ---------------------------------------------------------------------

  static renderNote(note: KbNote): string {
    const fm = [
      '---',
      `title: ${JSON.stringify(note.title)}`,
      `tags: ${JSON.stringify(note.tags)}`,
      `createdAt: ${JSON.stringify(note.createdAt)}`,
      `updatedAt: ${JSON.stringify(note.updatedAt)}`,
      '---',
      '',
      note.content,
    ]
    return fm.join('\n')
  }

  static parseNote(id: string, text: string): KbNote | null {
    const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    if (!m || m[1] === undefined) return null
    const fm: Record<string, string> = {}
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([\w]+)\s*:\s*(.*)$/)
      if (kv) fm[kv[1]!] = kv[2]!
    }
    let tags: string[] = []
    try {
      const parsed = JSON.parse(fm['tags'] ?? '[]')
      if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === 'string')
    } catch {
      tags = []
    }
    return {
      id,
      title: tryJsonString(fm['title']) ?? id,
      tags,
      content: (m[2] ?? '').trim(),
      createdAt: tryJsonString(fm['createdAt']) ?? '',
      updatedAt: tryJsonString(fm['updatedAt']) ?? '',
      file: '',
    }
  }
}

function tryJsonString(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw)
    return typeof v === 'string' ? v : undefined
  } catch {
    return raw
  }
}
