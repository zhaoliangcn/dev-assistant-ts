import { Router, type Request, type Response } from 'express'
import { writeFileSync, readFileSync } from 'node:fs'
import { SessionStore } from '../../persist/session-store.js'
import { log } from '../../utils/logger.js'

/**
 * 会话路由（对齐设计文档 12.1）。
 *
 * - GET    /api/sessions            列出会话（元信息 + 显示名）
 * - GET    /api/sessions/:id        会话详情（事件流）
 * - DELETE /api/sessions/:id        删除会话文件
 * - POST   /api/sessions/:id/rename 重命名（sidecar 文件 <session>.title）
 * - GET    /api/sessions/:id/export 导出 JSONL
 *
 * 会话列表为只读浏览（Web 层不接管进行中的会话；运行态属于 CLI/App 进程）。
 */

const STORE_DIR = '.dev-assistant-store'

/** 会话显示名：sidecar title 优先，否则首条 user 消息截断 */
async function sessionTitle(workingDir: string, sessionId: string, file: string): Promise<string> {
  try {
    const sidecar = readFileSync(`${file}.title`, 'utf8').trim()
    if (sidecar) return sidecar
  } catch {
    // 无 title sidecar
  }
  try {
    const events = await SessionStore.readEvents(file)
    const first = events.find((e) => e.type === 'user_message' && 'content' in e)
    if (first && typeof (first as { content?: string }).content === 'string') {
      const c = (first as { content: string }).content.trim()
      return c.length > 40 ? `${c.slice(0, 40)}…` : c
    }
  } catch {
    // 读取失败
  }
  return sessionId
}

export function sessionsRouter(workingDir: string): Router {
  const router = Router()

  router.get('/', async (_req: Request, res: Response) => {
    const sessions = SessionStore.listSessions(workingDir, STORE_DIR)
    const list = await Promise.all(
      sessions.map(async (s) => ({
        sessionId: s.sessionId,
        title: await sessionTitle(workingDir, s.sessionId, s.file),
        updatedAt: new Date(s.mtimeMs).toISOString(),
        sizeBytes: s.size,
      })),
    )
    res.json({ sessions: list })
  })

  router.get('/:id', async (req: Request, res: Response) => {
    const sessions = SessionStore.listSessions(workingDir, STORE_DIR)
    const target = sessions.find((s) => s.sessionId === req.params.id)
    if (!target) {
      res.status(404).json({ error: `会话不存在: ${req.params.id}` })
      return
    }
    const events = await SessionStore.readEvents(target.file)
    res.json({ sessionId: target.sessionId, eventCount: events.length, events })
  })

  router.delete('/:id', (req: Request, res: Response) => {
    const sessions = SessionStore.listSessions(workingDir, STORE_DIR)
    const target = sessions.find((s) => s.sessionId === req.params.id)
    if (!target) {
      res.status(404).json({ error: `会话不存在: ${req.params.id}` })
      return
    }
    SessionStore.deleteSession(target.file)
    log.info('Web 删除会话', { sessionId: target.sessionId })
    res.json({ ok: true, deleted: target.sessionId })
  })

  router.post('/:id/rename', (req: Request, res: Response) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
    if (!title) {
      res.status(400).json({ error: 'title 不能为空' })
      return
    }
    const sessions = SessionStore.listSessions(workingDir, STORE_DIR)
    const target = sessions.find((s) => s.sessionId === req.params.id)
    if (!target) {
      res.status(404).json({ error: `会话不存在: ${req.params.id}` })
      return
    }
    // 覆盖写：rename 语义是最后一次生效，append 会让标题逐次累积
    writeFileSync(`${target.file}.title`, `${title}\n`)
    res.json({ ok: true, sessionId: target.sessionId, title })
  })

  router.get('/:id/export', (req: Request, res: Response) => {
    const sessions = SessionStore.listSessions(workingDir, STORE_DIR)
    const target = sessions.find((s) => s.sessionId === req.params.id)
    if (!target) {
      res.status(404).json({ error: `会话不存在: ${req.params.id}` })
      return
    }
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('content-disposition', `attachment; filename="${target.sessionId}.jsonl"`)
    res.send(readFileSync(target.file, 'utf8'))
  })

  return router
}
