import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { nowIso } from '../../persist/events.js'

/**
 * 代码库分析会话（对齐设计文档 6.7 分析工具族）。
 *
 * 工作流（LLM 驱动，工具只做状态容器）：
 *   analyze_codebase(target)   → 开启分析会话（status=analyzing）
 *   record_analysis(finding)   → 逐条记录分析发现（架构/依赖/风险…）
 *   get_analysis_summary()     → 查看已记录条数与摘要
 *   finish_analysis()          → 收尾（status=completed，生成总结）
 *
 * 存储：进程内单例（按 workingDir）+ `.dev-assistant-analysis.json` 落盘
 * （重启后历史可查；进行中的分析重启后标记 stale）。
 */

export type AnalysisStatus = 'analyzing' | 'completed' | 'abandoned'

export interface AnalysisRecord {
  title: string
  content: string
  at: string
}

export interface AnalysisSession {
  id: string
  /** 分析目标（相对路径或"整个仓库"） */
  target: string
  status: AnalysisStatus
  createdAt: string
  updatedAt: string
  records: AnalysisRecord[]
}

const ANALYSIS_FILE = '.dev-assistant-analysis.json'
const MAX_RECORDS = 500
/** 单条发现长度上限 */
const MAX_RECORD_CHARS = 4_000

interface AnalysisFile {
  current?: AnalysisSession
  history: Array<Omit<AnalysisSession, 'records'> & { recordCount: number }>
}

/** 进程内单例：workingDir → 当前分析会话 */
const sessions = new Map<string, AnalysisSession>()

export class AnalysisStore {
  private file: string

  constructor(workingDir: string) {
    this.file = path.resolve(workingDir, ANALYSIS_FILE)
  }

  /** 当前会话（内存优先，无则从磁盘恢复） */
  async current(): Promise<AnalysisSession | undefined> {
    const key = this.file
    if (sessions.has(key)) return sessions.get(key)
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text) as AnalysisFile
      if (parsed.current) {
        // 重启后"analyzing"视为中断
        if (parsed.current.status === 'analyzing') {
          parsed.current.status = 'abandoned'
          await this.persist()
        }
        sessions.set(key, parsed.current)
        return parsed.current
      }
    } catch {
      // 无历史
    }
    return undefined
  }

  async history(): Promise<AnalysisFile['history']> {
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text) as AnalysisFile
      return Array.isArray(parsed.history) ? parsed.history : []
    } catch {
      return []
    }
  }

  /** 开启新分析会话（若已有进行中则复用） */
  async start(target: string): Promise<AnalysisSession> {
    const existing = await this.current()
    if (existing && existing.status === 'analyzing') {
      existing.target = target
      existing.updatedAt = nowIso()
      await this.persist()
      return existing
    }
    const session: AnalysisSession = {
      id: `analysis-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
      target,
      status: 'analyzing',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      records: [],
    }
    sessions.set(this.file, session)
    await this.persist()
    return session
  }

  /** 记录一条分析发现 */
  async record(title: string, content: string): Promise<AnalysisSession> {
    const session = await this.current()
    if (!session) throw new Error('没有进行中的分析会话（先调用 analyze_codebase）')
    if (session.status !== 'analyzing') {
      throw new Error(`分析会话已${session.status === 'completed' ? '完成' : '中断'}（不能继续记录；可重新 analyze_codebase）`)
    }
    const trimmed = content.trim().slice(0, MAX_RECORD_CHARS)
    if (!trimmed) throw new Error('分析记录内容不能为空')
    session.records.push({ title: title.trim() || '发现', content: trimmed, at: nowIso() })
    while (session.records.length > MAX_RECORDS) session.records.shift()
    session.updatedAt = nowIso()
    await this.persist()
    return session
  }

  /** 完成分析 */
  async finish(): Promise<AnalysisSession> {
    const session = await this.current()
    if (!session) throw new Error('没有进行中的分析会话')
    if (session.status !== 'analyzing') return session
    session.status = 'completed'
    session.updatedAt = nowIso()
    await this.persist()
    return session
  }

  private async persist(): Promise<void> {
    const session = sessions.get(this.file)
    if (!session) return
    const previous = (await this.history()).slice(-20)
    const data: AnalysisFile = {
      current: session,
      history: previous,
    }
    if (session.status === 'completed') {
      data.history.push({
        id: session.id,
        target: session.target,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        recordCount: session.records.length,
      })
    }
    await mkdir(path.dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(data, null, 2), 'utf8')
  }
}

export function analysisStore(workingDir: string): AnalysisStore {
  return new AnalysisStore(workingDir)
}
