import express, { type Express } from 'express'
import type { App } from '../app.js'
import { statusRouter } from './routes/status.js'
import { sessionsRouter } from './routes/sessions.js'
import { filesRouter } from './routes/files.js'
import { skillsRouter } from './routes/skills.js'
import { indexPageHandler, staticFileHandler } from './static.js'

/**
 * 路由组装（对齐设计文档 12.1）。
 *
 * 依赖注入：App 句柄 + 工作目录。CORS 允许跨域（devworkbench 嵌入场景）。
 */

export function buildRouter(app: App): Express {
  const router = express()
  router.use(express.json({ limit: '2mb' }))
  // CORS（嵌入场景）
  router.use((req, res, next) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type')
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })

  // 状态/模型
  const status = statusRouter({
    workingDir: app.workingDir,
    snapshot: () => ({
      sessionId: app.sessionId,
      approvalEnabled: !app.approval.isDisabled(),
      toolCount: app.tools.listNames().length,
      memoryCount: app.memory.size,
      schedulerRunning: app.scheduler.isRunning,
      uptimeSec: Math.round(process.uptime()),
      activeProvider: app.llm.activeConfig()?.name,
    }),
    switchModel: (name) => app.llm.setActiveByName(name),
  })
  router.use('/api', status) // /api/status 与 /api/models/* 同一 router（内部已带前缀）

  // 会话
  router.use('/api/sessions', sessionsRouter(app.workingDir))

  // 文件
  router.use('/api/files', filesRouter(app.workingDir))

  // 技能
  router.use('/api/skills', skillsRouter(app.workingDir))

  // 页面 + 静态资源（Express 5 通配：* 需命名参数）
  router.get('/', indexPageHandler(app.workingDir))
  router.get('/static/*filepath', staticFileHandler(app.workingDir))

  // 404
  router.use((req, res) => {
    res.status(404).json({ error: `未知路由: ${req.method} ${req.path}` })
  })

  return router
}
