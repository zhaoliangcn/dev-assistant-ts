import { Router, type Request, type Response } from 'express'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { loadSkills } from '../../skills/index.js'
import { log } from '../../utils/logger.js'

/**
 * 技能路由（对齐设计文档 12.1）——项目已安装技能管理。
 *
 * - GET    /api/skills           列出已安装技能
 * - POST   /api/skills/install   安装技能 { url, branch? }（Git 克隆，installer.ts）
 * - POST   /api/skills/preview   预览技能内容 { url, branch? }（克隆到临时目录读取 SKILL.md）
 * - DELETE /api/skills/:name     卸载技能（删除 .dev-assistant-skills/<name>）
 */

export function skillsRouter(workingDir: string): Router {
  const router = Router()
  const skillsRoot = path.resolve(workingDir, '.dev-assistant-skills')

  router.get('/', async (_req: Request, res: Response) => {
    try {
      const skills = await loadSkills(workingDir)
      res.json({
        skills: skills.map((s) => ({
          name: s.name,
          description: s.description,
          contentPreview: s.content.slice(0, 200),
          dir: path.relative(workingDir, s.dir),
        })),
      })
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  router.post('/install', async (req: Request, res: Response) => {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
    const branch = typeof req.body?.branch === 'string' ? req.body.branch.trim() : undefined
    if (!url) {
      res.status(400).json({ error: 'url 必填（Git 仓库地址）' })
      return
    }
    try {
      const { installSkillFromGit } = await import('../../skills/installer.js')
      const skill = await installSkillFromGit(workingDir, url, branch)
      log.info('Web 安装技能', { name: skill.name, url })
      res.json({ ok: true, name: skill.name, description: skill.description })
    } catch (e) {
      const status = e instanceof Error && /已存在/.test(e.message) ? 409 : 400
      res.status(status).json({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  router.post('/preview', async (req: Request, res: Response) => {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
    const branch = typeof req.body?.branch === 'string' ? req.body.branch.trim() : undefined
    if (!url) {
      res.status(400).json({ error: 'url 必填' })
      return
    }
    try {
      const { previewSkillFromGit } = await import('../../skills/installer.js')
      const preview = await previewSkillFromGit(url, branch)
      res.json(preview)
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  router.delete('/:name', async (req: Request, res: Response) => {
    const rawName = req.params.name
    const name = typeof rawName === 'string' ? rawName : ''
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      res.status(400).json({ error: '技能名非法' })
      return
    }
    const dir = path.join(skillsRoot, name)
    try {
      await rm(dir, { recursive: true, force: true })
      log.info('Web 卸载技能', { name })
      res.json({ ok: true, deleted: name })
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  return router
}
