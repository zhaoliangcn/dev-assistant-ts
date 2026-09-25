import { describe, expect, it } from 'vitest'
import { parseOpenAiSseLine, parseRetryAfter, sseDataLines, httpError } from '../../src/llm/provider/common.js'
import { AppError } from '../../src/utils/error.js'

describe('parseOpenAiSseLine', () => {
  it('解析文本增量', () => {
    const d = parseOpenAiSseLine(
      JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
    )
    expect(d?.text).toBe('Hello')
    expect(d?.toolCalls).toEqual([])
  })

  it('解析 reasoning_content / reasoning / thinking', () => {
    for (const field of ['reasoning_content', 'reasoning', 'thinking']) {
      const d = parseOpenAiSseLine(
        JSON.stringify({ choices: [{ delta: { [field]: 'think...' } }] }),
      )
      expect(d?.reasoning).toBe('think...')
    }
  })

  it('工具调用分片累积（index 稳定）', () => {
    const d1 = parseOpenAiSseLine(
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }],
      }),
    )
    expect(d1?.toolCalls[0]).toEqual({ id: 'call_1', name: 'read_file', arguments: '{"pa' })

    const d2 = parseOpenAiSseLine(
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }],
      }),
    )
    expect(d2?.toolCalls[0]).toEqual({ id: '', name: '', arguments: 'th":"a.txt"}' })
  })

  it('多工具调用按 index 区分', () => {
    const d = parseOpenAiSseLine(
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'fn1', arguments: '{}' } },
                { index: 1, id: 'b', function: { name: 'fn2', arguments: '{}' } },
              ],
            },
          },
        ],
      }),
    )
    expect(d?.toolCalls[0]?.id).toBe('a')
    expect(d?.toolCalls[1]?.id).toBe('b')
  })

  it('解析 usage', () => {
    const d = parseOpenAiSseLine(
      JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 } }),
    )
    expect(d?.usage).toEqual({ prompt: 11, completion: 22, total: 33 })
  })

  it('非流式 message.tool_calls 一次性下发', () => {
    const d = parseOpenAiSseLine(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'x', function: { name: 'fn', arguments: '{"a":1}' } }],
            },
          },
        ],
      }),
    )
    expect(d?.toolCalls[0]).toEqual({ id: 'x', name: 'fn', arguments: '{"a":1}' })
  })

  it('空 delta / 无效 JSON 返回 null', () => {
    expect(parseOpenAiSseLine(JSON.stringify({ choices: [{ delta: {} }] }))).toBeNull()
    expect(parseOpenAiSseLine('not json')).toBeNull()
  })
})

describe('parseRetryAfter', () => {
  it('秒数', () => {
    expect(parseRetryAfter('30')).toBe(30_000)
    expect(parseRetryAfter('0')).toBe(0)
  })
  it('HTTP 日期', () => {
    const future = new Date(Date.now() + 60_000).toUTCString()
    const ms = parseRetryAfter(future)
    expect(ms).not.toBeNull()
    expect(ms!).toBeGreaterThanOrEqual(55_000)
    expect(ms!).toBeLessThanOrEqual(65_000)
  })
  it('无效值返回 null', () => {
    expect(parseRetryAfter(undefined)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('garbage')).toBeNull()
  })
  it('数组取第一个', () => {
    expect(parseRetryAfter(['5', '6'])).toBe(5000)
  })
})

describe('httpError', () => {
  it('携带 status 与 body 摘要', () => {
    const e = httpError(500, 'internal error', {})
    expect(e).toBeInstanceOf(AppError)
    expect(e.status).toBe(500)
    expect(e.isServerError()).toBe(true)
  })
  it('body 截断到 300 字符', () => {
    const e = httpError(429, 'x'.repeat(1000), {})
    expect(e.message).toContain('…')
    expect(e.message.length).toBeLessThan(400)
  })
  it('Retry-After 头解析', () => {
    const e = httpError(429, 'slow down', { 'retry-after': '12' })
    expect(e.retryAfter()).toBe(12_000)
  })
})

describe('sseDataLines', () => {
  function toStream(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c))
        controller.close()
      },
    })
  }

  it('完整 SSE 流', async () => {
    const lines: string[] = []
    for await (const l of sseDataLines(
      toStream(['data: {"a":1}\n\ndata: {"b":2}\n\n', 'data: [DONE]\n']),
    )) {
      lines.push(l)
    }
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('跨 chunk 的不完整行拼接', async () => {
    const lines: string[] = []
    for await (const l of sseDataLines(toStream(['data: {"hel', 'lo":1}\n\n']))) {
      lines.push(l)
    }
    expect(lines).toEqual(['{"hello":1}'])
  })

  it('忽略注释行与空行', async () => {
    const lines: string[] = []
    for await (const l of sseDataLines(toStream([': keep-alive\n\ndata: x\n\n', '\n']))) {
      lines.push(l)
    }
    expect(lines).toEqual(['x'])
  })

  it('CRLF 行尾', async () => {
    const lines: string[] = []
    for await (const l of sseDataLines(toStream(['data: a\r\n\r\ndata: b\r\n\r\n']))) {
      lines.push(l)
    }
    expect(lines).toEqual(['a', 'b'])
  })

  it('流结束时的残留行（无尾换行）', async () => {
    const lines: string[] = []
    for await (const l of sseDataLines(toStream(['data: tail']))) {
      lines.push(l)
    }
    expect(lines).toEqual(['tail'])
  })
})
