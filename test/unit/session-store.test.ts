import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SessionStore } from '../../src/persist/session-store.js'
import { nowIso, type SessionEvent } from '../../src/persist/events.js'

/**
 * SessionStore（JSONL 持久化）测试。
 */

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-persist-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function ev(type: SessionEvent['type'], extra: Partial<SessionEvent> = {}): SessionEvent {
  const base = { timestamp: nowIso(), sessionId: 'test' } as Record<string, unknown>
  return { ...base, type, ...extra } as SessionEvent
}

describe('SessionStore', () => {
  it('append + flush 落盘为 JSONL', async () => {
    const store = new SessionStore(dir)
    store.append(ev('user_message', { content: '你好' }))
    store.append(ev('assistant_message', { content: 'hi' }))
    store.close()

    const content = await readFile(store.getFilePath(), 'utf8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]!) as SessionEvent
    expect(first.type).toBe('user_message')
    expect(first.content).toBe('你好')
  })

  it('文件命名 session_<时间戳>.jsonl', () => {
    const store = new SessionStore(dir)
    expect(path.basename(store.getFilePath())).toMatch(/^session_.+\.jsonl$/)
    store.close()
  })

  it('listSessions 按时间倒序', async () => {
    const s1 = new SessionStore(dir)
    s1.append(ev('user_message', { content: 'a' }))
    s1.close()
    // 确保 mtime 不同
    await new Promise((r) => setTimeout(r, 20))
    const s2 = new SessionStore(dir)
    s2.append(ev('user_message', { content: 'b' }))
    s2.close()

    const sessions = SessionStore.listSessions(dir)
    expect(sessions.length).toBeGreaterThanOrEqual(2)
    expect(sessions[0]!.file).toBe(s2.getFilePath())
    expect(sessions[0]!.mtimeMs).toBeGreaterThanOrEqual(sessions[1]!.mtimeMs)
  })

  it('readEvents 还原全部事件', async () => {
    const store = new SessionStore(dir)
    store.append(ev('user_message', { content: 'q1' }))
    store.append(ev('tool_call_request', { toolCallId: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }))
    store.append(ev('tool_result', { toolCallId: 'c1', name: 'read_file', success: true, content: 'data' }))
    store.append(ev('assistant_message', { content: 'a1' }))
    store.append(ev('context_compression', { beforeTokens: 1000, afterTokens: 200 }))
    store.close()

    const events = await SessionStore.readEvents(store.getFilePath())
    expect(events).toHaveLength(5)
    expect(events[0]).toMatchObject({ type: 'user_message', content: 'q1' })
    expect(events[2]).toMatchObject({ type: 'tool_result', success: true })
    expect(events[4]).toMatchObject({ type: 'context_compression', beforeTokens: 1000 })
  })

  it('损坏行被跳过（崩溃恢复）', async () => {
    const store = new SessionStore(dir)
    store.append(ev('user_message', { content: 'ok' }))
    store.close()
    // 追加半行（模拟崩溃）
    const { appendFileSync } = await import('node:fs')
    appendFileSync(store.getFilePath(), '{"type":"assistant_message","content":"broken', 'utf8')

    const events = await SessionStore.readEvents(store.getFilePath())
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ content: 'ok' })
  })

  it('deleteSession 删除文件', async () => {
    const store = new SessionStore(dir)
    store.append(ev('user_message', { content: 'x' }))
    store.close()
    const file = store.getFilePath()
    SessionStore.deleteSession(file)
    const exists = await import('node:fs/promises').then((m) => m.access(file).then(() => true, () => false))
    expect(exists).toBe(false)
  })

  it('resume 模式复用指定文件', async () => {
    const store = new SessionStore(dir)
    store.append(ev('user_message', { content: 'original' }))
    store.close()
    const file = store.getFilePath()

    const resumed = new SessionStore(dir, undefined, file)
    expect(resumed.getFilePath()).toBe(path.resolve(file))
    resumed.append(ev('assistant_message', { content: 'continuation' }))
    resumed.close()

    const events = await SessionStore.readEvents(file)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ content: 'continuation' })
  })

  it('批量 flush 阈值触发（PERSIST_FLUSH_BATCH）', async () => {
    const realEnv = process.env.PERSIST_FLUSH_BATCH
    process.env.PERSIST_FLUSH_BATCH = '3'
    try {
      const store = new SessionStore(dir)
      store.append(ev('user_message', { content: '1' }))
      store.append(ev('user_message', { content: '2' }))
      // 未到阈值，尚未落盘
      expect(store.pendingCount).toBe(2)
      store.append(ev('user_message', { content: '3' }))
      // 达到阈值，自动落盘
      expect(store.pendingCount).toBe(0)
      store.close()

      const events = await SessionStore.readEvents(store.getFilePath())
      expect(events).toHaveLength(3)
    } finally {
      if (realEnv === undefined) delete process.env.PERSIST_FLUSH_BATCH
      else process.env.PERSIST_FLUSH_BATCH = realEnv
    }
  })

  it('空 store 目录 listSessions 返回空', async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-empty-'))
    expect(SessionStore.listSessions(emptyDir)).toHaveLength(0)
    await rm(emptyDir, { recursive: true, force: true })
  })

  it('不存在的目录 listSessions 返回空', () => {
    expect(SessionStore.listSessions(path.join(dir, 'no-such-dir'))).toHaveLength(0)
  })
})
