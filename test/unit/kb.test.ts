import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { KbStore } from '../../src/tools/kb/kb-store.js'
import { kbStoreHandler, kbStoreSpec } from '../../src/tools/kb/kb-store-tool.js'
import { kbQueryHandler, kbQuerySpec } from '../../src/tools/kb/kb-query.js'
import { ReadCache } from '../../src/tools/cache.js'

/**
 * Phase 4 知识库测试：KbStore 存储/查询 + kb_store/kb_query 工具。
 */

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-kb-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function toolCtx(workingDir: string) {
  return {
    workingDir,
    cache: new ReadCache(),
    sessionId: 'sess-test',
  }
}

describe('KbStore.slugify', () => {
  it('中文/空格/标点转 slug', () => {
    expect(KbStore.slugify('Git 提交规范 v2.0!')).toBe('git-提交规范-v2-0')
    expect(KbStore.slugify('  ')).toMatch(/^note-/)
  })
})

describe('KbStore.put / loadNote', () => {
  it('写入后读取（frontmatter 往返一致）', async () => {
    const store = new KbStore(dir)
    const note = await store.put('API 约定', '所有接口走 /api 前缀', ['api', 'http'])
    expect(note.id).toBe('api-约定')
    expect(note.tags).toEqual(['api', 'http'])

    const loaded = await store.loadNote(note.id)
    expect(loaded.title).toBe('API 约定')
    expect(loaded.content).toBe('所有接口走 /api 前缀')
    expect(loaded.createdAt).toBe(note.createdAt)
  })

  it('同标题覆盖更新（保留 createdAt）', async () => {
    const store = new KbStore(dir)
    const first = await store.put('踩坑记录', '第一次记录', [])
    await new Promise((r) => setTimeout(r, 10))
    const second = await store.put('踩坑记录', '第二次记录（覆盖）', ['bug'])

    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt >= first.updatedAt).toBe(true)

    const loaded = await store.loadNote(second.id)
    expect(loaded.content).toBe('第二次记录（覆盖）')
    expect((await store.list()).length).toBeGreaterThanOrEqual(2)
  })

  it('空内容/空标题抛错', async () => {
    const store = new KbStore(dir)
    await expect(store.put('标题', '   ')).rejects.toThrow()
    await expect(store.put('   ', '内容')).rejects.toThrow()
  })

  it('超长正文截断到 20000 字符', async () => {
    const store = new KbStore(dir)
    const note = await store.put('长笔记', '长'.repeat(25_000), [])
    // 正文截断到 20000 + 截断提示后缀
    expect(note.content.length).toBeLessThanOrEqual(20_010)
    expect(note.content).toContain('超长已截断')
  })
})

describe('KbStore.list / query / remove', () => {
  let store: KbStore

  beforeAll(async () => {
    store = new KbStore(dir)
    await store.put('调度器时间轮', '时间轮 27 槽位，INTERVAL_MS=1000，用于定时任务调度', ['scheduler', 'time-wheel'])
    await store.put('持久化设计', 'JSONL 事件存储，PERSIST_FLUSH_BATCH=10 批量落盘', ['persist'])
    await store.put('安全策略', '危险级别 low/medium/high/critical 对应审批策略', ['security'])
  })

  it('list 返回全部笔记元信息', async () => {
    const notes = await store.list()
    const titles = notes.map((n) => n.title)
    expect(titles).toContain('调度器时间轮')
    expect(titles).toContain('安全策略')
  })

  it('query 关键词命中（相关度排序）', async () => {
    const results = await store.query(['时间轮'])
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.note.title).toBe('调度器时间轮')
    expect(results[0]!.note.content).toContain('27 槽位')
  })

  it('query 多关键词命中多篇', async () => {
    const results = await store.query(['持久化'])
    expect(results.some((r) => r.note.title === '持久化设计')).toBe(true)
  })

  it('query 标签过滤', async () => {
    const results = await store.query(['调度'], ['scheduler'])
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.note.tags.includes('scheduler'))).toBe(true)

    const none = await store.query(['时间轮'], ['不存在的标签'])
    expect(none).toEqual([])
  })

  it('query 无匹配返回空', async () => {
    const results = await store.query(['完全不存在的关键词xyz'])
    expect(results).toEqual([])
  })

  it('limit 生效', async () => {
    const results = await store.query(['设计'], [], 1)
    expect(results.length).toBeLessThanOrEqual(1)
  })

  it('remove 删除笔记', async () => {
    const store2 = new KbStore(dir)
    const note = await store2.put('临时笔记', '待删除', [])
    expect(await store2.remove(note.id)).toBe(true)
    expect(await store2.remove(note.id)).toBe(false)
    expect((await store2.list()).map((n) => n.id)).not.toContain(note.id)
  })
})

describe('kb_store / kb_query 工具', () => {
  it('specs 命名与危险级别', () => {
    expect(kbStoreSpec.name).toBe('kb_store')
    expect(kbStoreSpec.dangerLevel).toBe('low')
    expect(kbQuerySpec.name).toBe('kb_query')
    expect(kbQuerySpec.dangerLevel).toBe('low')
  })

  it('kb_store 存入成功', async () => {
    const r = await kbStoreHandler(
      { arguments: { title: '工具测试笔记', content: '工具写入的内容', tags: ['test'] } },
      toolCtx(dir),
    )
    expect(r.success).toBe(true)
    expect(r.content).toContain('已存入知识库')
  })

  it('kb_store 缺参数报错', async () => {
    const r = await kbStoreHandler({ arguments: {} }, toolCtx(dir))
    expect(r.success).toBe(false)
    expect(r.content).toContain('title')
  })

  it('kb_query 查回刚存入的笔记', async () => {
    const r = await kbQueryHandler(
      { arguments: { keywords: ['工具写入的内容'] } },
      toolCtx(dir),
    )
    expect(r.success).toBe(true)
    expect(r.content).toContain('工具测试笔记')
  })

  it('kb_query action=list 列目录', async () => {
    const r = await kbQueryHandler({ arguments: { action: 'list' } }, toolCtx(dir))
    expect(r.success).toBe(true)
    expect(r.content).toContain('工具测试笔记')
  })

  it('kb_query 无 keywords 且无 tags 报错', async () => {
    const r = await kbQueryHandler({ arguments: {} }, toolCtx(dir))
    expect(r.success).toBe(false)
    expect(r.content).toContain('keywords')
  })

  it('磁盘文件格式为 frontmatter + 正文', async () => {
    const raw = await readFile(path.join(dir, '.dev-assistant-kb', '工具测试笔记.md'), 'utf8')
    expect(raw.startsWith('---\n')).toBe(true)
    expect(raw).toContain('工具写入的内容')
    expect(raw).toContain('tags: ["test"]')
  })
})
