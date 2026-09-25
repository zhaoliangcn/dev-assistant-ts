import { Router, type Request, type Response } from 'express'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseModelsConfig, DEFAULT_CONFIG_NAME } from '../../config/index.js'
import { AppError } from '../../utils/error.js'
import { log } from '../../utils/logger.js'

/**
 * 状态/模型路由（对齐设计文档 12.1）。
 *
 * - GET    /api/status            运行状态（会话/审批/工具/调度）
 * - GET    /api/models            模型配置列表（apiKey 脱敏）
 * - POST   /api/models            追加模型配置（写回 TOML）
 * - DELETE /api/models/:name      删除模型条目（写回 TOML）
 * - POST   /api/models/switch     运行时热切换活跃 provider
 */

export interface StatusRouterDeps {
  workingDir: string
  /** App 运行快照（由 server 注入，支持实时状态） */
  snapshot: () => Record<string, unknown>
  /** 热切换活跃 provider（由 server 注入 LlmClient.setActiveByName） */
  switchModel?: (name: string) => boolean
}

/** TOML 字符串转义 */
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 把当前 [[models]] 配置序列化为 TOML（apiKey 原样保留，含 ${ENV} 占位符） */
export function modelsToToml(models: Array<Record<string, unknown>>): string {
  const parts: string[] = ['# dev-assistant-ts 模型配置（Web 层可编辑；apiKey 支持 ${ENV_VAR} 占位符）']
  for (const m of models) {
    const lines = ['[[models]]']
    for (const [k, v] of Object.entries(m)) {
      if (v === undefined || v === null) continue
      if (typeof v === 'boolean') lines.push(`${k} = ${v ? 'true' : 'false'}`)
      else if (typeof v === 'number') lines.push(`${k} = ${v}`)
      else lines.push(`${k} = ${tomlStr(String(v))}`)
    }
    parts.push(lines.join('\n'))
  }
  return `${parts.join('\n\n')}\n`
}

export function statusRouter(deps: StatusRouterDeps): Router {
  const router = Router()
  const configPath = path.resolve(deps.workingDir, DEFAULT_CONFIG_NAME)

  function readConfig(): Array<Record<string, unknown>> {
    if (!existsSync(configPath)) return []
    return readFileSync(configPath, 'utf8').match(/\[\[models\]\][\s\S]*?(?=\n\[\[models\]\]|\n*$)/g)?.map((block) => {
      const t: Record<string, unknown> = {}
      for (const line of block.split('\n')) {
        const m = line.match(/^([a-z_]+)\s*=\s*(.+)$/)
        if (!m) continue
        let v = m[2]!.trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1)
        } else {
          const n = Number(v)
          if (!Number.isNaN(n) && v !== '') t[m[1]!] = n
          continue
        }
        t[m[1]!] = v
      }
      return t
    }) ?? []
  }

  function writeConfig(models: Array<Record<string, unknown>>): void {
    writeFileSync(configPath, modelsToToml(models), 'utf8')
  }

  router.get('/status', (_req: Request, res: Response) => {
    res.json({ ok: true, ...deps.snapshot() })
  })

  router.get('/models', (_req: Request, res: Response) => {
    const models = readConfig().map((m) => ({
      ...m,
      api_key: m.api_key !== undefined ? '***' : undefined,
    }))
    res.json({ models })
  })

  router.post('/models', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!name || !model) {
      res.status(400).json({ error: 'name 与 model 必填' })
      return
    }
    const models = readConfig()
    if (models.some((m) => m.name === name)) {
      res.status(409).json({ error: `模型 ${name} 已存在` })
      return
    }
    const entry: Record<string, unknown> = {
      name,
      provider: typeof body.provider === 'string' ? body.provider : 'openai',
      api_url: typeof body.apiUrl === 'string' ? body.apiUrl : 'https://api.openai.com/v1',
      model,
    }
    if (typeof body.apiKey === 'string' && body.apiKey !== '***') {
      entry.api_key = body.apiKey
    }
    if (typeof body.temperature === 'number') entry.temperature = body.temperature
    if (typeof body.maxOutputTokens === 'number') entry.max_output_tokens = body.maxOutputTokens
    models.push(entry)
    try {
      // 写前校验（parse 一次确保合法）
      parseModelsConfig(modelsToToml(models))
      writeConfig(models)
    } catch (e) {
      res.status(400).json({ error: e instanceof AppError ? e.message : String(e) })
      return
    }
    log.info('Web 添加模型', { name })
    res.json({ ok: true, name })
  })

  router.delete('/models/:name', (req: Request, res: Response) => {
    const models = readConfig()
    const next = models.filter((m) => m.name !== req.params.name)
    if (next.length === models.length) {
      res.status(404).json({ error: `模型不存在: ${req.params.name}` })
      return
    }
    if (next.length === 0) {
      res.status(400).json({ error: '至少保留一个模型条目' })
      return
    }
    writeConfig(next)
    log.info('Web 删除模型', { name: req.params.name })
    res.json({ ok: true, deleted: req.params.name })
  })

  router.post('/models/switch', (req: Request, res: Response) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!name) {
      res.status(400).json({ error: 'name 必填' })
      return
    }
    if (!deps.switchModel || !deps.switchModel(name)) {
      res.status(404).json({ error: `模型不存在: ${name}` })
      return
    }
    log.info('Web 切换模型', { name })
    res.json({ ok: true, active: name })
  })

  return router
}
