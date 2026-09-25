import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LlmClient, NO_MODEL_HINT } from '../../src/llm/client.js'
import { AppError } from '../../src/utils/error.js'
import { startMockLlmServer, type MockLlmServerHandle } from '../fixtures/mock-llm-server.js'
import type { ProviderConfig } from '../../src/llm/models.js'

/**
 * LlmClient 故障转移 / 热切换 / 错误聚合测试。
 */

let okMock: MockLlmServerHandle
let failMock: MockLlmServerHandle

function okCfg(name = 'ok'): ProviderConfig {
  return { name, provider: 'openai', apiUrl: `${okMock.url}/v1`, apiKey: 'k', model: 'gpt-ok' }
}
function failCfg(name = 'fail'): ProviderConfig {
  return { name, provider: 'openai', apiUrl: `${failMock.url}/v1`, apiKey: 'k', model: 'gpt-fail' }
}

describe('LlmClient', () => {
  beforeAll(async () => {
    okMock = await startMockLlmServer({
      '/v1/chat/completions': { nonStream: { type: 'text', content: 'from-ok' }, stream: { type: 'text', content: 'from-ok' } },
    })
    // 永远 429 且 Retry-After: 0（transient → 重试耗尽，但秒级完成）
    failMock = await startMockLlmServer({
      '/v1/chat/completions': { fail: { status: 429, times: 999, retryAfterSec: 0 }, nonStream: { type: 'text', content: 'never' } },
    })
  })

  afterAll(async () => {
    await okMock.close()
    await failMock.close()
  })

  it('无 provider 时抛出 NO_MODEL_HINT', async () => {
    const c = new LlmClient([])
    await expect(c.call([{ role: 'user', content: 'x' }])).rejects.toThrow(NO_MODEL_HINT)
    await c.close()
  })

  it('首个 provider 429 重试耗尽后转移到下一个', async () => {
    const c = new LlmClient([failCfg(), okCfg()])
    try {
      const res = await c.call([{ role: 'user', content: 'hi' }])
      expect(res.kind).toBe('text')
      if (res.kind === 'text') expect(res.content).toBe('from-ok')
      // 活跃 provider 已切换
      expect(c.activeConfig()?.name).toBe('ok')
      // failMock 收到 1 + MAX_RETRIES(5) = 6 次请求
      const failCount = failMock.requests.filter((r) => r.path === '/v1/chat/completions').length
      expect(failCount).toBe(6)
    } finally {
      await c.close()
    }
  })

  it('setActiveByName 热切换', async () => {
    const c = new LlmClient([failCfg(), okCfg()])
    try {
      expect(c.activeConfig()?.name).toBe('fail')
      expect(c.setActiveByName('ok')).toBe(true)
      expect(c.activeConfig()?.name).toBe('ok')
      expect(c.setActiveByName('nope')).toBe(false)
      const res = await c.call([{ role: 'user', content: 'hi' }])
      if (res.kind === 'text') expect(res.content).toBe('from-ok')
    } finally {
      await c.close()
    }
  })

  it('所有 provider 均失败时抛出最后错误', async () => {
    const c = new LlmClient([failCfg(), failCfg('fail2')])
    try {
      await expect(c.call([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
        kind: 'llm',
        status: 429,
      })
    } finally {
      await c.close()
    }
  })

  it('provider 名称列表', () => {
    const c = new LlmClient([okCfg('a'), okCfg('b')])
    expect(c.providerNames()).toEqual(['a', 'b'])
    expect(c.isEmpty()).toBe(false)
    void c.close()
  })

  it('流式：首个 provider 失败后转移到成功 provider', async () => {
    const c = new LlmClient([failCfg(), okCfg()])
    try {
      let text = ''
      for await (const ev of await c.callStream([{ role: 'user', content: 'hi' }])) {
        if (ev.kind === 'chunk') text += ev.content
      }
      expect(text).toBe('from-ok')
    } finally {
      await c.close()
    }
  }, 60_000)

  it('4xx（fatal）不重试，但故障转移到下一 provider', async () => {
    const bad = await startMockLlmServer({
      '/v1/chat/completions': { nonStream: { type: 'error', status: 401, message: 'unauthorized' } },
    })
    const c = new LlmClient([
      { name: 'bad', provider: 'openai', apiUrl: `${bad.url}/v1`, apiKey: 'k', model: 'm' },
      okCfg(),
    ])
    try {
      // fatal 错误不重试，但仍转移到下一个 provider（与故障转移语义一致）
      const res = await c.call([{ role: 'user', content: 'x' }])
      if (res.kind === 'text') expect(res.content).toBe('from-ok')
      // 未重试：bad 只收到 1 次请求
      expect(bad.requests).toHaveLength(1)
      // 已转移到 ok
      expect(c.activeConfig()?.name).toBe('ok')
    } finally {
      await c.close()
      await bad.close()
    }
  })

  it('连接层错误（connect reset）走快速重试', async () => {
    const c = new LlmClient([
      { name: 'dead', provider: 'openai', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' },
    ])
    try {
      const start = Date.now()
      await expect(c.call([{ role: 'user', content: 'x' }])).rejects.toThrow(AppError)
      // 2 次 network 重试（500ms + 1000ms）总耗时远小于 transient 的 5 次指数退避
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(15_000)
    } finally {
      await c.close()
    }
  }, 30_000)
})
