import { Router, type Request, type Response } from 'express'
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import { AppError } from '../../utils/error.js'

/**
 * 文件路由（对齐设计文档 12.1）——项目目录文件浏览。
 *
 * - GET  /api/files?path=          列目录（path 缺省为项目根）
 * - GET  /api/files/content?path=  读文件（上限 512KB）
 * - POST /api/files/save           保存文件 { path, content }（原子写）
 *
 * 安全：所有路径 resolve 后必须仍在工作目录内（防目录穿越）。
 */

const MAX_READ_BYTES = 512 * 1024
const MAX_LIST_ENTRIES = 500
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib', '.bin', '.woff', '.woff2', '.ttf'])

export function filesRouter(workingDir: string): Router {
  const router = Router()

  /** 路径安全解析：必须位于 workingDir 内 */
  function resolveSafe(rel: string): string {
    const resolved = path.resolve(workingDir, rel || '.')
    const root = path.resolve(workingDir)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw AppError.Io('路径超出工作目录')
    }
    return resolved
  }

  router.get('/', async (req: Request, res: Response) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '.'
    let abs: string
    try {
      abs = resolveSafe(rel)
    } catch (e) {
      res.status(400).json({ error: e instanceof AppError ? e.message : String(e) })
      return
    }
    if (!existsSync(abs)) {
      res.status(404).json({ error: '路径不存在' })
      return
    }
    const st = statSync(abs)
    if (!st.isDirectory()) {
      res.status(400).json({ error: '不是目录' })
      return
    }

    const entries = await fg('**/*', {
      cwd: abs,
      onlyFiles: false,
      deep: 2,
      dot: false,
      ignore: ['node_modules/**', '.git/**', 'dist/**', 'target/**'],
    })
      .then((list) => list.slice(0, MAX_LIST_ENTRIES))
      .catch(() => [])

    res.json({ path: path.relative(workingDir, abs) || '.', entries })
  })

  router.get('/content', (req: Request, res: Response) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : ''
    if (!rel) {
      res.status(400).json({ error: 'path 必填' })
      return
    }
    let abs: string
    try {
      abs = resolveSafe(rel)
    } catch (e) {
      res.status(400).json({ error: e instanceof AppError ? e.message : String(e) })
      return
    }
    if (!existsSync(abs)) {
      res.status(404).json({ error: '文件不存在' })
      return
    }
    const st = statSync(abs)
    if (st.isDirectory()) {
      res.status(400).json({ error: '是目录，不是文件' })
      return
    }
    if (st.size > MAX_READ_BYTES) {
      res.status(413).json({ error: `文件过大（${st.size} > ${MAX_READ_BYTES} 字节）` })
      return
    }
    if (BINARY_EXT.has(path.extname(abs).toLowerCase())) {
      res.status(415).json({ error: '二进制文件不支持在线查看' })
      return
    }
    try {
      const content = readFileSync(abs, 'utf8')
      res.json({ path: rel, content, size: st.size })
    } catch (e) {
      res.status(415).json({ error: `读取失败（可能为二进制）: ${e instanceof Error ? e.message : String(e)}` })
    }
  })

  router.post('/save', (req: Request, res: Response) => {
    const rel = typeof req.body?.path === 'string' ? req.body.path : ''
    const content = typeof req.body?.content === 'string' ? req.body.content : undefined
    if (!rel || content === undefined) {
      res.status(400).json({ error: 'path 与 content 必填' })
      return
    }
    let abs: string
    try {
      abs = resolveSafe(rel)
    } catch (e) {
      res.status(400).json({ error: e instanceof AppError ? e.message : String(e) })
      return
    }
    try {
      mkdirSync(path.dirname(abs), { recursive: true })
      // 简单原子写：tmp + rename
      const tmp = `${abs}.tmp-${Date.now()}`
      writeFileSync(tmp, content, 'utf8')
      renameSync(tmp, abs)
      res.json({ ok: true, path: rel, bytes: Buffer.byteLength(content) })
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  return router
}
