import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LlmClient } from '../../src/llm/client.js'
import { startMockLlmServer, type MockLlmServerHandle } from '../fixtures/mock-llm-server.js'
import type { ProviderConfig } from '../../src/llm/models.js'

/**
 * OpenAI 兼容 provider 集成测试（经真实 HTTP 走 mock server）。
 */

let mock: MockLlmServerHandle
let client: LlmClient

function cfg(name = 'mock'): ProviderConfig {
  return { name, provider: 'openai', apiUrl: `${mock.url}/v1`, apiKey: 'sk-test', model: 'gpt-test' }
}

beforeAll(async () => {
  mock = await startMockLlmServer({
    '/v1/chat/completions': {
      stream: { type: 'text', content: '你好，世界' },
      nonStream: { type: 'text', content: '你好，世界' },
    },
  })
  client = new LlmClient([cfg()])
})

afterAll(async () => {
  await client.close()
  await mock.close()
})

describe('OpenAIProvider.chat（非流式）', () => {
  it('返回文本', async () => {
    const res = await client.call([{ role: 'user', content: 'hi' }])
    expect(res.kind).toBe('text')
    if (res.kind === 'text') {
      expect(res.content).toBe('你好，世界')
      expect(res.usage).toMatchObject({ promptTokens: 10, completionTokens: 20, totalTokens: 30 })
    }
  })

  it('请求体正确（messages/temperature/stream=false）', async () => {
    await client.call([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }])
    const req = mock.requests[mock.requests.length - 1]
    expect(req.path).toBe('/v1/chat/completions')
    expect(req.headers.authorization).toBe('Bearer sk-test')
    expect(req.body.stream).toBe(false)
    expect(req.body.model).toBe('gpt-test')
    expect(req.body.temperature).toBe(0.2)
    expect(req.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('tools 透传', async () => {
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'read_file', description: '读取文件', parameters: { type: 'object' } },
      },
    ]
    await client.call([{ role: 'user', content: 'hi' }], tools)
    const req = mock.requests[mock.requests.length - 1]
    expect(req.body.tools).toEqual(tools)
  })

  it('assistant 工具调用消息正确序列化（tool_calls 结构）', async () => {
    await client.call([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'file content' },
    ])
    const req = mock.requests[mock.requests.length - 1]
    expect(req.body.messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    })
    expect(req.body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'file content' })
  })
})

describe('OpenAIProvider.chatStream（流式）', () => {
  it('产出 chunk 增量 + usage + done', async () => {
    const events: string[] = []
    let text = ''
    let usage: { promptTokens: number } | undefined
    for await (const ev of await client.callStream([{ role: 'user', content: 'hi' }])) {
      events.push(ev.kind)
      if (ev.kind === 'chunk') text += ev.content
      if (ev.kind === 'usage') usage = ev.usage
    }
    expect(text).toBe('你好，世界')
    expect(events[events.length - 1]).toBe('done')
    expect(events).toContain('usage')
    expect(usage).toMatchObject({ promptTokens: 10 })
  })

  it('请求体 stream=true 且带 stream_options.include_usage', async () => {
    const gen = await client.callStream([{ role: 'user', content: 'hi' }])
    for await (const _ of gen) {
      // 消费完
    }
    const req = mock.requests[mock.requests.length - 1]
    expect(req.body.stream).toBe(true)
    expect(req.body.stream_options).toEqual({ include_usage: true })
  })
})

describe('错误处理', () => {
  it('4xx 不重试，直接抛出带 status 的 AppError', async () => {
    const bad = await startMockLlmServer({
      '/v1/chat/completions': { nonStream: { type: 'error', status: 400, message: 'bad request' } },
    })
    const c = new LlmClient([{ name: 'bad', provider: 'openai', apiUrl: `${bad.url}/v1`, apiKey: 'k', model: 'm' }])
    try {
      await expect(c.call([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ status: 400 })
      expect(bad.requests).toHaveLength(1) // 未重试
    } finally {
      await c.close()
      await bad.close()
    }
  })
})
