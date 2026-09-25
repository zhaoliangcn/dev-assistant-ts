import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { log } from '../utils/logger.js'
import type { SessionEvent } from './events.js'

/**
 * JSONL SessionStore（对齐设计文档 10 节 + Rust 版批量 flush 策略）。
 *
 * - 文件命名：`.dev-assistant-store/session_<ISO 时间戳>.jsonl`
 * - 写入：buffer 累积，达到 PERSIST_FLUSH_BATCH（默认 10）或 PERSIST_FLUSH_INTERVAL_MS（默认 1000）时
 *   用 appendFileSync 落盘（同步写保证每条记录立即可见，避免异步乱序）
 * - 进程退出前强制 flush
 */

const DEFAULT_STORE_DIR = '.dev-assistant-store'

export function flushBatchSize(): number {
  return intEnv('PERSIST_FLUSH_BATCH', 10)
}

export function flushIntervalMs(): number {
  return intEnv('PERSIST_FLUSH_INTERVAL_MS', 1000)
}

function intEnv(name: string, def: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def
}

export class SessionStore {
  readonly dir: string
  readonly sessionId: string
  private readonly filePath: string
  private buffer: SessionEvent[] = []
  private lastFlushAt = Date.now()
  private timer: NodeJS.Timeout | null = null

  constructor(workingDir: string, storeDir?: string, resumeFile?: string) {
    this.dir = path.resolve(workingDir, storeDir ?? DEFAULT_STORE_DIR)
    mkdirSync(this.dir, { recursive: true })

    if (resumeFile) {
      // 恢复模式：复用已有会话文件
      this.filePath = path.resolve(resumeFile)
      this.sessionId = path.basename(this.filePath, '.jsonl').replace(/^session_/, '')
    } else {
      // 秒级时间戳 + 8 位 uuid 后缀：避免同秒内创建两个会话时文件名碰撞
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)
      this.sessionId = `${ts}-${randomUUID().slice(0, 8)}`
      this.filePath = path.join(this.dir, `session_${this.sessionId}.jsonl`)
    }

    // 定时 flush
    const interval = flushIntervalMs()
    if (interval > 0) {
      this.timer = setInterval(() => this.flush(), interval)
      this.timer.unref?.()
    }
  }

  getFilePath(): string {
    return this.filePath
  }

  /** 追加事件（自动按 batch/interval flush） */
  append(event: SessionEvent): void {
    this.buffer.push(event)
    if (this.buffer.length >= flushBatchSize()) {
      this.flush()
    }
  }

  /** 强制落盘 */
  flush(): void {
    if (this.buffer.length === 0) return
    const lines = this.buffer.map((e) => JSON.stringify(e)).join('\n') + '\n'
    try {
      appendFileSync(this.filePath, lines, 'utf8')
      this.buffer = []
      this.lastFlushAt = Date.now()
    } catch (e) {
      log.error(`会话持久化写入失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 停止定时 flush 并强制落盘 */
  close(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.flush()
  }

  get lastFlushTime(): number {
    return this.lastFlushAt
  }

  get pendingCount(): number {
    return this.buffer.length
  }

  // -------------------------------------------------------------------------
  // 读取 / 会话列表（恢复 + Web 层共用）
  // -------------------------------------------------------------------------

  /** 列出 store 目录下的所有会话（按时间倒序） */
  static listSessions(workingDir: string, storeDir?: string): Array<{ sessionId: string; file: string; mtimeMs: number; size: number }> {
    const dir = path.resolve(workingDir, storeDir ?? DEFAULT_STORE_DIR)
    if (!existsSync(dir)) return []
    const entries = readdirSync(dir)
      .filter((f) => f.startsWith('session_') && f.endsWith('.jsonl'))
      .map((f) => {
        const file = path.join(dir, f)
        const st = statSync(file)
        return { sessionId: f.replace(/^session_/, '').replace(/\.jsonl$/, ''), file, mtimeMs: st.mtimeMs, size: st.size }
      })
    return entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  /** 流式读取会话全部事件 */
  static async readEvents(file: string): Promise<SessionEvent[]> {
    const events: SessionEvent[] = []
    const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
    for await (const line of rl) {
      const t = line.trim()
      if (!t) continue
      try {
        const parsed = JSON.parse(t) as SessionEvent
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') {
          events.push(parsed)
        }
      } catch {
        // 跳过损坏行（最后一行可能因崩溃半写）
      }
    }
    return events
  }

  /** 删除会话文件 */
  static deleteSession(file: string): void {
    if (existsSync(file)) unlinkSync(file)
  }
}
