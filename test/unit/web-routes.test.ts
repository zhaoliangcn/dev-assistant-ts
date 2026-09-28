import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Router } from 'express'
import type { Server } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import { modelsToToml, statusRouter } from '../../src/web/routes/status.js'
import { filesRouter } from '../../src/web/routes/files.js'
import { sessionsRouter } from '../../src/web/routes/sessions.js'
import { skillsRouter } from '../../src/web/routes/skills.js'
import { DEFAULT_CONFIG_NAME, parseModelsConfig } from '../../src/config/index.js'

/**
 * Web API 路由层集成测试（对齐设计文档 12.1）。
 *
 * `buildRouter()` 需要完整 App（llm/tools/memory/scheduler/approval），
 * 这里改为把各 router 工厂单独挂到裸 express + 临时端口，用真实 HTTP 请求验证
 * 状态码、错误文案与落盘副作用（模型 TOML / 会话文件 / 技能目录）。
 */

const exec = promisify(execFile)

interface Resp {
  status: number
  body: Record<string, any>
  text: string
  headers: Headers
}

/** 起一个只挂载目标 router 的服务 */
async function startApp(router: Router, mountAt: string): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use(mountAt, router)
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1')
    s.once('listening', () => resolve(s))
    s.once('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((err?: Error) => (err ? reject(err) : resolve())))
    },
  }
}

async function req(base: string, method: string, urlPath: string, body?: unknown): Promise<Resp> {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: Record<string, any> = {}
  try {
    parsed = JSON.parse(text) as Record<string, any>
  } catch {
    // 非 JSON 响应（如 JSONL 导出）保留原文
  }
  return { status: res.status, body: parsed, text, headers: res.headers }
}

// =============================================================================
// modelsToToml（纯函数）
// =============================================================================

describe('modelsToToml', () => {
  it('基础类型序列化：布尔 / 数字原样，字符串加引号', () => {
    const toml = modelsToToml([
      {
        name: 'gpt',
        provider: 'openai',
        model: 'gpt-4o',
        temperature: 0.2,
        max_output_tokens: 8192,
        stream: true,
        disable: false,
      },
    ])
    expect(toml).toContain('# dev-assistant-ts 模型配置')
    expect(toml).toContain('[[models]]')
    expect(toml).toContain('name = "gpt"')
    expect(toml).toContain('temperature = 0.2')
    expect(toml).toContain('max_output_tokens = 8192')
    expect(toml).toContain('stream = true')
    expect(toml).toContain('disable = false')
  })

  it('跳过 undefined / null 字段', () => {
    const toml = modelsToToml([{ name: 'a', api_key: undefined, model: null, provider: 'ollama' }])
    expect(toml).not.toContain('api_key')
    expect(toml).not.toContain('model =')
    expect(toml).toContain('provider = "ollama"')
  })

  it('转义引号与反斜杠', () => {
    const toml = modelsToToml([{ name: 'q"uote', provider: 'openai', model: 'a\\b' }])
    expect(toml).toContain('name = "q\\"uote"')
    expect(toml).toContain('model = "a\\\\b"')
  })

  it('多条目顺序保留且以换行结尾', () => {
    const toml = modelsToToml([
      { name: 'a', provider: 'openai', model: 'm1' },
      { name: 'b', provider: 'anthropic', model: 'm2' },
    ])
    expect(toml.indexOf('name = "a"')).toBeLessThan(toml.indexOf('name = "b"'))
    expect(toml).toContain('[[models]]\nname = "b"')
    expect(toml.endsWith('\n')).toBe(true)
  })

  it('空数组只保留注释头', () => {
    expect(modelsToToml([])).toBe('# dev-assistant-ts 模型配置（Web 层可编辑；apiKey 支持 ${ENV_VAR} 占位符）\n')
  })

  it('产物可被 parseModelsConfig 读回（往返一致）', () => {
    const source = [
      { name: 'gpt', provider: 'openai', api_url: 'https://api.openai.com/v1', model: 'gpt-4o', temperature: 0.5 },
    ]
    const cfg = parseModelsConfig(modelsToToml(source))
    expect(cfg.models[0]).toMatchObject({ name: 'gpt', provider: 'openai', model: 'gpt-4o', temperature: 0.5 })
  })
})

// =============================================================================
// statusRouter
// =============================================================================

describe('statusRouter（/api/status + /api/models）', () => {
  let dir: string
  let base: string
  let close: () => Promise<void>
  let switchCalls: string[]

  const CONFIG_TWO_MODELS = [
    '# dev-assistant-ts 模型配置',
    '[[models]]',
    'name = "gpt"',
    'provider = "openai"',
    'api_url = "https://api.openai.com/v1"',
    'api_key = "sk-secret"',
    'model = "gpt-4o"',
    'temperature = 0.2',
    'max_output_tokens = 8192',
    '',
    '[[models]]',
    'name = "claude"',
    'provider = "anthropic"',
    'api_url = "https://api.anthropic.com"',
    'model = "claude-3-5"',
    '',
  ].join('\n')

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-web-status-'))
    await writeFile(path.join(dir, DEFAULT_CONFIG_NAME), CONFIG_TWO_MODELS, 'utf8')
    switchCalls = []
    const app = await startApp(
      statusRouter({
        workingDir: dir,
        snapshot: () => ({ sessionId: 'sess-1', model: 'gpt', toolCount: 27 }),
        switchModel: (name) => {
          switchCalls.push(name)
          return name === 'claude'
        },
      }),
      '/api',
    )
    base = app.base
    close = app.close
  })

  afterAll(async () => {
    await close()
    await rm(dir, { recursive: true, force: true })
  })

  const currentModels = async () => parseModelsConfig(await readFile(path.join(dir, DEFAULT_CONFIG_NAME), 'utf8'))

  it('GET /status 合并 snapshot 字段', async () => {
    const r = await req(base, 'GET', '/api/status')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, sessionId: 'sess-1', model: 'gpt', toolCount: 27 })
  })

  it('GET /models 解析所有条目并对 api_key 脱敏', async () => {
    const r = await req(base, 'GET', '/api/models')
    expect(r.status).toBe(200)
    expect(r.body.models).toHaveLength(2)
    expect(r.body.models[0]).toMatchObject({
      name: 'gpt',
      provider: 'openai',
      api_key: '***',
      temperature: 0.2,
      max_output_tokens: 8192,
    })
    expect(r.text).not.toContain('sk-secret')
    // 无 api_key 的条目不应凭空多出字段
    expect('api_key' in r.body.models[1]).toBe(false)
  })

  it('POST /models 缺 name 或 model 返回 400', async () => {
    expect((await req(base, 'POST', '/api/models', { name: 'x' })).status).toBe(400)
    const r = await req(base, 'POST', '/api/models', { model: 'y' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('name 与 model 必填')
  })

  it('POST /models 同名返回 409 且不写盘', async () => {
    const before = await readFile(path.join(dir, DEFAULT_CONFIG_NAME), 'utf8')
    const r = await req(base, 'POST', '/api/models', { name: 'gpt', model: 'gpt-4o' })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('模型 gpt 已存在')
    expect(await readFile(path.join(dir, DEFAULT_CONFIG_NAME), 'utf8')).toBe(before)
  })

  it('POST /models 成功追加并写回 TOML（全字段映射）', async () => {
    const r = await req(base, 'POST', '/api/models', {
      name: 'glm',
      model: 'glm-4.6',
      provider: 'openai-compatible',
      apiUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'env-secret',
      temperature: 0.7,
      maxOutputTokens: 4096,
    })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, name: 'glm' })

    const cfg = await currentModels()
    expect(cfg.models).toHaveLength(3)
    expect(cfg.models[2]).toMatchObject({
      name: 'glm',
      provider: 'openai-compatible',
      apiUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'env-secret',
      temperature: 0.7,
      maxOutputTokens: 4096,
    })
  })

  it('POST /models 未提供 provider/apiUrl 时用默认值', async () => {
    await req(base, 'POST', '/api/models', { name: 'dflt', model: 'm' })
    const cfg = await currentModels()
    expect(cfg.models.find((m) => m.name === 'dflt')).toMatchObject({
      provider: 'openai',
      apiUrl: 'https://api.openai.com/v1',
    })
  })

  it('POST /models 保留脱敏占位（apiKey 为 *** 时不写 api_key）', async () => {
    await req(base, 'POST', '/api/models', { name: 'masked', model: 'm', apiKey: '***' })
    const cfg = await currentModels()
    expect(cfg.models.find((m) => m.name === 'masked')?.apiKey).toBeUndefined()
  })

  it('POST /models 非法 provider 被写前校验拦下（400 且原文件未变）', async () => {
    const before = await readFile(path.join(dir, DEFAULT_CONFIG_NAME), 'utf8')
    const r = await req(base, 'POST', '/api/models', { name: 'bad', model: 'm', provider: 'grok' })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('provider 取值非法')
    expect(await readFile(path.join(dir, DEFAULT_CONFIG_NAME), 'utf8')).toBe(before)
  })

  it('POST /models temperature 越界同样 400', async () => {
    const r = await req(base, 'POST', '/api/models', { name: 'hot', model: 'm', temperature: 9 })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('temperature 超出 [0, 2] 范围')
  })

  it('DELETE /models/:name 未知模型 404', async () => {
    const r = await req(base, 'DELETE', '/api/models/nope')
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('模型不存在: nope')
  })

  it('DELETE /models/:name 成功删除其余条目', async () => {
    const r = await req(base, 'DELETE', '/api/models/glm')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, deleted: 'glm' })
    const cfg = await currentModels()
    expect(cfg.models.some((m) => m.name === 'glm')).toBe(false)
  })

  it('POST /models/switch 缺 name 400', async () => {
    const r = await req(base, 'POST', '/api/models/switch', {})
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('name 必填')
  })

  it('POST /models/switch 回调返回 false 时 404', async () => {
    const r = await req(base, 'POST', '/api/models/switch', { name: 'gpt' })
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('模型不存在: gpt')
  })

  it('POST /models/switch 成功时回调并回 active', async () => {
    const r = await req(base, 'POST', '/api/models/switch', { name: 'claude' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, active: 'claude' })
    expect(switchCalls).toContain('claude')
  })
})

describe('statusRouter 边界（仅剩一条 / 未注入 switchModel / 无配置文件）', () => {
  let dir: string
  let base: string
  let close: () => Promise<void>

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-web-status2-'))
    await writeFile(
      path.join(dir, DEFAULT_CONFIG_NAME),
      ['[[models]]', 'name = "only"', 'provider = "ollama"', 'model = "q3"'].join('\n'),
      'utf8',
    )
    const app = await startApp(statusRouter({ workingDir: dir, snapshot: () => ({}) }), '/api')
    base = app.base
    close = app.close
  })

  afterAll(async () => {
    await close()
    await rm(dir, { recursive: true, force: true })
  })

  it('ollama 条目缺省本地 api_url 仍可解析', async () => {
    const cfg = parseModelsConfig(await readFile(path.join(dir, DEFAULT_CONFIG_NAME), 'utf8'))
    expect(cfg.models[0]).toMatchObject({ provider: 'ollama', apiUrl: 'http://127.0.0.1:11434/v1' })
  })

  it('GET /models 无 api_key 时不返回该字段', async () => {
    const r = await req(base, 'GET', '/api/models')
    expect(r.body.models).toEqual([{ name: 'only', provider: 'ollama', model: 'q3' }])
  })

  it('DELETE 最后一条被拒绝（至少保留一个模型条目）', async () => {
    const r = await req(base, 'DELETE', '/api/models/only')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('至少保留一个模型条目')
    expect(await readFile(path.join(dir, DEFAULT_CONFIG_NAME), 'utf8')).toContain('name = "only"')
  })

  it('未注入 switchModel 时一律 404', async () => {
    const r = await req(base, 'POST', '/api/models/switch', { name: 'only' })
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('模型不存在: only')
  })

  it('配置文件不存在时 GET /models 返回空列表', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'dev-assistant-web-status3-'))
    const app = await startApp(statusRouter({ workingDir: empty, snapshot: () => ({}) }), '/api')
    try {
      const r = await req(app.base, 'GET', '/api/models')
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ models: [] })
    } finally {
      await app.close()
      await rm(empty, { recursive: true, force: true })
    }
  })
})

// =============================================================================
// filesRouter
// =============================================================================

describe('filesRouter（/api/files）', () => {
  let dir: string
  let base: string
  let close: () => Promise<void>

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-web-files-'))
    await mkdir(path.join(dir, 'sub/deep/deeper'), { recursive: true })
    await mkdir(path.join(dir, 'node_modules/pkg'), { recursive: true })
    await Promise.all([
      writeFile(path.join(dir, 'a.txt'), 'hello 世界', 'utf8'),
      writeFile(path.join(dir, 'logo.png'), 'fake-bytes', 'utf8'),
      writeFile(path.join(dir, 'big.txt'), 'x'.repeat(512 * 1024 + 1), 'utf8'),
      writeFile(path.join(dir, '.hidden'), 'H', 'utf8'),
      writeFile(path.join(dir, 'sub/b.txt'), 'B', 'utf8'),
      writeFile(path.join(dir, 'sub/deep/c.txt'), 'C', 'utf8'),
      writeFile(path.join(dir, 'sub/deep/deeper/d.txt'), 'D', 'utf8'),
      writeFile(path.join(dir, 'node_modules/pkg/index.js'), 'x', 'utf8'),
    ])
    const app = await startApp(filesRouter(dir), '/api/files')
    base = app.base
    close = app.close
  }, 30_000)

  afterAll(async () => {
    await close()
    await rm(dir, { recursive: true, force: true })
  })

  it('GET / 列目录：相对条目、忽略依赖目录与隐藏文件', async () => {
    const r = await req(base, 'GET', '/api/files')
    expect(r.status).toBe(200)
    expect(r.body.path).toBe('.')
    expect(r.body.entries).toEqual(expect.arrayContaining(['a.txt', 'sub', 'sub/b.txt', 'sub/deep']))
    // deep:2 → 第三层不展开
    expect(r.body.entries).not.toContain('sub/deep/c.txt')
    expect(r.body.entries).not.toContain('node_modules/pkg')
    expect(r.body.entries).not.toContain('.hidden')
  })

  it('GET /?path=sub 以子目录为根返回相对路径', async () => {
    const r = await req(base, 'GET', '/api/files?path=sub')
    expect(r.status).toBe(200)
    expect(r.body.path).toBe('sub')
    expect(r.body.entries).toEqual(expect.arrayContaining(['b.txt', 'deep', 'deep/c.txt']))
    expect(r.body.entries).not.toContain('deep/deeper/d.txt')
  })

  it('GET / 目录穿越 400 / 不存在 404 / 传文件 400', async () => {
    const outside = await req(base, 'GET', '/api/files?path=../../etc')
    expect(outside.status).toBe(400)
    expect(outside.body.error).toBe('路径超出工作目录')
    expect((await req(base, 'GET', '/api/files?path=nope')).status).toBe(404)
    const notDir = await req(base, 'GET', '/api/files?path=a.txt')
    expect(notDir.status).toBe(400)
    expect(notDir.body.error).toBe('不是目录')
  })

  it('GET /content 读取文本（UTF-8 原文 + 字节数）', async () => {
    const r = await req(base, 'GET', '/api/files/content?path=a.txt')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ path: 'a.txt', content: 'hello 世界', size: Buffer.byteLength('hello 世界') })
  })

  it('GET /content 参数校验：缺 path / 穿越 / 不存在 / 目录', async () => {
    expect((await req(base, 'GET', '/api/files/content')).body.error).toBe('path 必填')
    expect((await req(base, 'GET', '/api/files/content?path=../x')).body.error).toBe('路径超出工作目录')
    expect((await req(base, 'GET', '/api/files/content?path=nope.txt')).status).toBe(404)
    const dirErr = await req(base, 'GET', '/api/files/content?path=sub')
    expect(dirErr.status).toBe(400)
    expect(dirErr.body.error).toBe('是目录，不是文件')
  })

  it('GET /content 超过 512KB 返回 413', async () => {
    const r = await req(base, 'GET', '/api/files/content?path=big.txt')
    expect(r.status).toBe(413)
    expect(r.body.error).toBe(`文件过大（${512 * 1024 + 1} > ${512 * 1024} 字节）`)
  })

  it('GET /content 二进制扩展名返回 415', async () => {
    const r = await req(base, 'GET', '/api/files/content?path=logo.png')
    expect(r.status).toBe(415)
    expect(r.body.error).toBe('二进制文件不支持在线查看')
  })

  it('POST /save 写入新建嵌套目录并返回字节数', async () => {
    const r = await req(base, 'POST', '/api/files/save', { path: 'src/deep/note.md', content: '# hi\n中文' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, path: 'src/deep/note.md', bytes: Buffer.byteLength('# hi\n中文') })
    expect(await readFile(path.join(dir, 'src/deep/note.md'), 'utf8')).toBe('# hi\n中文')
  })

  it('POST /save 覆盖已有文件且不残留 tmp 文件', async () => {
    await req(base, 'POST', '/api/files/save', { path: 'a.txt', content: 'replaced' })
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('replaced')
    const list = await req(base, 'GET', '/api/files')
    expect(list.body.entries.filter((e: string) => e.startsWith('a.txt.tmp-'))).toEqual([])
  })

  it('POST /save 允许空内容（bytes 0）', async () => {
    const r = await req(base, 'POST', '/api/files/save', { path: 'empty.txt', content: '' })
    expect(r.status).toBe(200)
    expect(r.body.bytes).toBe(0)
    expect(await readFile(path.join(dir, 'empty.txt'), 'utf8')).toBe('')
  })

  it('POST /save 缺 path 或 content 非字符串 400', async () => {
    expect((await req(base, 'POST', '/api/files/save', { path: 'x.txt' })).body.error).toBe('path 与 content 必填')
    expect((await req(base, 'POST', '/api/files/save', { path: 'x.txt', content: 123 })).body.error).toBe(
      'path 与 content 必填',
    )
    expect((await req(base, 'POST', '/api/files/save', { content: 'x' })).body.error).toBe('path 与 content 必填')
  })

  it('POST /save 目录穿越 400', async () => {
    const r = await req(base, 'POST', '/api/files/save', { path: '../escape.txt', content: 'x' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('路径超出工作目录')
  })

  it('POST /save 目标是目录时 rename 失败返回 500', async () => {
    const r = await req(base, 'POST', '/api/files/save', { path: 'sub', content: 'x' })
    expect(r.status).toBe(500)
    expect(r.body.error).toBeTruthy()
  })
})

// =============================================================================
// sessionsRouter
// =============================================================================

describe('sessionsRouter（/api/sessions）', () => {
  let dir: string
  let store: string
  let base: string
  let close: () => Promise<void>

  const LONG = '这是一条很长很长用来验证会话标题四十字符截断行为的用户消息，需要超过四十个字符才能触发截断。'
  const SESSION_A = '2026-01-01T00-00-00-000-aaaa1111'
  const SESSION_B = '2026-01-02T00-00-00-000-bbbb2222'
  const SESSION_C = '2026-01-03T00-00-00-000-cccc3333'

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-web-sessions-'))
    store = path.join(dir, '.dev-assistant-store')
    await mkdir(store, { recursive: true })
    await Promise.all([
      writeFile(
        path.join(store, `session_${SESSION_A}.jsonl`),
        [
          JSON.stringify({ type: 'user_message', content: '帮我修个 bug' }),
          JSON.stringify({ type: 'assistant_message', content: '好的' }),
          '{ 半行损坏的 JSONL 应被跳过',
        ].join('\n') + '\n',
        'utf8',
      ),
      writeFile(
        path.join(store, `session_${SESSION_B}.jsonl`),
        JSON.stringify({ type: 'user_message', content: LONG }) + '\n',
        'utf8',
      ),
      // 会话 C：无 user_message，标题回退为 sessionId
      writeFile(
        path.join(store, `session_${SESSION_C}.jsonl`),
        JSON.stringify({ type: 'status', content: 'x' }) + '\n',
        'utf8',
      ),
    ])
    const app = await startApp(sessionsRouter(dir), '/api/sessions')
    base = app.base
    close = app.close
  })

  afterAll(async () => {
    await close()
    await rm(dir, { recursive: true, force: true })
  })

  it('GET / 列出会话元信息并按标题规则取名', async () => {
    const r = await req(base, 'GET', '/api/sessions')
    expect(r.status).toBe(200)
    expect(r.body.sessions).toHaveLength(3)
    const byId: Record<string, any> = Object.fromEntries(r.body.sessions.map((s: any) => [s.sessionId, s]))
    expect(byId[SESSION_A].title).toBe('帮我修个 bug')
    expect(byId[SESSION_A].sizeBytes).toBeGreaterThan(0)
    expect(new Date(byId[SESSION_A].updatedAt).getTime()).not.toBeNaN()
    expect(byId[SESSION_B].title).toBe(`${LONG.slice(0, 40)}…`)
    expect(byId[SESSION_C].title).toBe(SESSION_C)
  })

  it('GET /:id 返回事件流（损坏行被忽略）', async () => {
    const r = await req(base, 'GET', `/api/sessions/${SESSION_A}`)
    expect(r.status).toBe(200)
    expect(r.body.sessionId).toBe(SESSION_A)
    expect(r.body.eventCount).toBe(2)
    expect(r.body.events.map((e: any) => e.type)).toEqual(['user_message', 'assistant_message'])
  })

  it('GET /:id 未知会话 404', async () => {
    const r = await req(base, 'GET', '/api/sessions/nope')
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('会话不存在: nope')
  })

  it('POST /:id/rename 空标题 400 / 未知会话 404', async () => {
    expect((await req(base, 'POST', `/api/sessions/${SESSION_A}/rename`, { title: '   ' })).body.error).toBe(
      'title 不能为空',
    )
    expect((await req(base, 'POST', '/api/sessions/ghost/rename', { title: 'x' })).status).toBe(404)
  })

  it('POST /:id/rename 写 sidecar 并反映到列表标题', async () => {
    const r = await req(base, 'POST', `/api/sessions/${SESSION_B}/rename`, { title: '  重构计划 v2  ' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, sessionId: SESSION_B, title: '重构计划 v2' })
    expect(await readFile(path.join(store, `session_${SESSION_B}.jsonl.title`), 'utf8')).toBe('重构计划 v2\n')
    const list = await req(base, 'GET', '/api/sessions')
    expect(list.body.sessions.find((s: any) => s.sessionId === SESSION_B).title).toBe('重构计划 v2')
  })

  it('GET /:id/export 原样返回 JSONL 并带下载头', async () => {
    const res = await fetch(`${base}/api/sessions/${SESSION_A}/export`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${SESSION_A}.jsonl"`)
    const text = await res.text()
    expect(text.split('\n')[0]).toContain('"user_message"')
    expect(text).toContain('半行损坏的 JSONL')
  })

  it('GET /:id/export 未知会话 404', async () => {
    expect((await req(base, 'GET', '/api/sessions/ghost/export')).status).toBe(404)
  })

  it('DELETE /:id 删除会话文件后 404', async () => {
    const r = await req(base, 'DELETE', `/api/sessions/${SESSION_C}`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, deleted: SESSION_C })
    expect((await req(base, 'DELETE', `/api/sessions/${SESSION_C}`)).status).toBe(404)
    const list = await req(base, 'GET', '/api/sessions')
    expect(list.body.sessions.map((s: any) => s.sessionId)).not.toContain(SESSION_C)
  })

  it('store 目录不存在时列表为空', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'dev-assistant-web-sessions-empty-'))
    const app = await startApp(sessionsRouter(empty), '/api/sessions')
    try {
      const r = await req(app.base, 'GET', '/api/sessions')
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ sessions: [] })
    } finally {
      await app.close()
      await rm(empty, { recursive: true, force: true })
    }
  })
})

// =============================================================================
// skillsRouter
// =============================================================================

describe('skillsRouter（/api/skills）', () => {
  let dir: string
  let repo: string
  let base: string
  let close: () => Promise<void>

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-web-skills-'))
    await mkdir(path.join(dir, '.dev-assistant-skills/preset-skill'), { recursive: true })
    await mkdir(path.join(dir, '.dev-assistant-skills/broken'), { recursive: true })
    await writeFile(
      path.join(dir, '.dev-assistant-skills/preset-skill/SKILL.md'),
      '---\nname: preset-skill\ndescription: 预置技能描述\n---\n\n正文：做 A 做 B。',
      'utf8',
    )
    // 缺 description 的技能应被 loadSkills 跳过
    await writeFile(path.join(dir, '.dev-assistant-skills/broken/SKILL.md'), '---\nname: broken\n---\n正文', 'utf8')

    // 本地 git 仓库供 install/preview 使用（file:// 克隆，不依赖网络）
    repo = await mkdtemp(path.join(tmpdir(), 'dev-assistant-skill-repo-'))
    await writeFile(
      path.join(repo, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: 测试技能（来自本地仓库）\n---\n\n技能正文：做 C 做 D。',
      'utf8',
    )
    await exec('git', ['init', '-q'], { cwd: repo })
    await exec('git', ['add', '.'], { cwd: repo })
    await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init skill'], {
      cwd: repo,
    })

    const app = await startApp(skillsRouter(dir), '/api/skills')
    base = app.base
    close = app.close
  }, 60_000)

  afterAll(async () => {
    await close()
    await rm(dir, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  })

  it('GET / 列出合法技能（跳过缺 frontmatter 的目录）', async () => {
    const r = await req(base, 'GET', '/api/skills')
    expect(r.status).toBe(200)
    expect(r.body.skills).toHaveLength(1)
    expect(r.body.skills[0]).toMatchObject({
      name: 'preset-skill',
      description: '预置技能描述',
      dir: path.join('.dev-assistant-skills', 'preset-skill'),
    })
    expect(r.body.skills[0].contentPreview).toContain('做 A 做 B')
  })

  it('POST /install 缺 url 400', async () => {
    const r = await req(base, 'POST', '/api/skills/install', { url: '  ' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('url 必填（Git 仓库地址）')
  })

  it('POST /preview 缺 url 400', async () => {
    const r = await req(base, 'POST', '/api/skills/preview', {})
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('url 必填')
  })

  it('POST /preview 解析本地仓库技能且不落地', async () => {
    const r = await req(base, 'POST', '/api/skills/preview', { url: `file://${repo}` })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ name: 'demo-skill', description: '测试技能（来自本地仓库）', path: 'SKILL.md' })
    expect(r.body.content).toContain('做 C 做 D')
    const list = await req(base, 'GET', '/api/skills')
    expect(list.body.skills.map((s: any) => s.name)).not.toContain('demo-skill')
  }, 30_000)

  it('POST /install 成功 → 重复安装 409 → 卸载后列表复原', async () => {
    const first = await req(base, 'POST', '/api/skills/install', { url: `file://${repo}` })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ ok: true, name: 'demo-skill', description: '测试技能（来自本地仓库）' })
    expect(await readFile(path.join(dir, '.dev-assistant-skills/demo-skill/SKILL.md'), 'utf8')).toContain('做 C')

    const dup = await req(base, 'POST', '/api/skills/install', { url: `file://${repo}` })
    expect(dup.status).toBe(409)
    expect(dup.body.error).toContain('已存在')

    const removed = await req(base, 'DELETE', '/api/skills/demo-skill')
    expect(removed.status).toBe(200)
    expect(removed.body).toEqual({ ok: true, deleted: 'demo-skill' })
    const list = await req(base, 'GET', '/api/skills')
    expect(list.body.skills.map((s: any) => s.name)).toEqual(['preset-skill'])
  }, 60_000)

  it('POST /install 仓库无 SKILL.md 时 400', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'dev-assistant-empty-repo-'))
    try {
      await writeFile(path.join(bare, 'README.md'), 'no skill here', 'utf8')
      await exec('git', ['init', '-q'], { cwd: bare })
      await exec('git', ['add', '.'], { cwd: bare })
      await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: bare })
      const r = await req(base, 'POST', '/api/skills/install', { url: `file://${bare}` })
      expect(r.status).toBe(400)
      expect(r.body.error).toContain('SKILL.md')
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  }, 60_000)

  it('POST /preview 克隆失败 400', async () => {
    const r = await req(base, 'POST', '/api/skills/preview', { url: 'file:///definitely/not/a/repo' })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('git 克隆失败')
  }, 30_000)

  it('DELETE /:name 非法技能名 400', async () => {
    for (const name of ['bad~name', 'bad%20name', 'bad.name']) {
      const r = await req(base, 'DELETE', `/api/skills/${name}`)
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('技能名非法')
    }
  })

  it('DELETE /:name 对合法但不存在的技能幂等成功', async () => {
    const r = await req(base, 'DELETE', '/api/skills/never-installed')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, deleted: 'never-installed' })
  })

  it('技能目录不存在时 GET / 返回空列表', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'dev-assistant-web-skills-empty-'))
    const app = await startApp(skillsRouter(empty), '/api/skills')
    try {
      const r = await req(app.base, 'GET', '/api/skills')
      expect(r.status).toBe(200)
      expect(r.body).toEqual({ skills: [] })
    } finally {
      await app.close()
      await rm(empty, { recursive: true, force: true })
    }
  })
})
