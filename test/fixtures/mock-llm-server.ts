import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'

/**
 * Mock LLM Server（OpenAI 兼容协议）。
 * 支持：
 * - 流式 SSE（text / tool_calls / usage）
 * - 非流式（text / tool_calls / error）
 * - 注入 429/500 错误（前 N 次请求失败，用于重试与故障转移测试）
 * - 记录所有请求
 *
 * 用法：
 *   const mock = await startMockLlmServer()
 *   const client = new LlmClient([cfg], { ... })
 *   ...
 *   await mock.close()
 */

export interface RecordedRequest {
  path: string
  headers: Record<string, string | string[] | undefined>
  body: any
}

/** startMockLlmServer 返回句柄（与 MockLlmServer 类区分，避免声明合并） */
export interface MockLlmServerHandle {
  url: string
  port: number
  requests: RecordedRequest[]
  close(): Promise<void>
}

type FailPolicy =
  | { status: number; times: number; retryAfterSec?: number }
  | { type: 'connect-reset'; times: number }
  | null

type StreamResponse = { type: 'text'; content: string; reasoning?: string }
type ToolStreamResponse = {
  type: 'tool'
  content?: string
  calls: Array<{ id: string; name: string; arguments: string }>
}
type NonStreamResponse =
  | { type: 'text'; content: string }
  | { type: 'tool'; calls: Array<{ id: string; name: string; arguments: string }> }
  | { type: 'error'; status: number; message: string }

interface Route {
  path: string
  stream?: StreamResponse | ToolStreamResponse
  nonStream?: NonStreamResponse
  fail?: FailPolicy
}

export class MockLlmServer extends EventEmitter {
  requests: RecordedRequest[] = []

  constructor(private routes: Map<string, Route>) {
    super()
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: any = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
      const path = req.url ?? '/'
      this.requests.push({ path, headers: req.headers, body })

      const route = this.routes.get(path)
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `no route ${path}` } }))
        return
      }

      if (route.fail && route.fail.times > 0) {
        route.fail.times--
        const f = route.fail
        if (f.type === 'connect-reset') {
          req.socket?.destroy()
          return
        }
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (f.retryAfterSec !== undefined) headers['retry-after'] = String(f.retryAfterSec)
        res.writeHead(f.status, headers)
        res.end(JSON.stringify({ error: { message: `mock error ${f.status}` } }))
        return
      }

      if (body?.stream === true && (route.stream || route.nonStream)) {
        const payload = route.stream ?? this.nonStreamToStream(route.nonStream!)
        this.writeSse(res, payload, body)
      } else {
        const payload = route.nonStream ?? this.streamToNonStream(route.stream!)
        if (payload.type === 'error') {
          res.writeHead(payload.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: payload.message } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        if (payload.type === 'tool') {
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: payload.calls[0] ? null : '',
                    tool_calls: payload.calls.map((c) => ({
                      id: c.id,
                      type: 'function',
                      function: { name: c.name, arguments: c.arguments },
                    })),
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            }),
          )
        } else {
          res.end(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: payload.content } }],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            }),
          )
        }
      }
    })
  }

  private nonStreamToStream(r: NonStreamResponse): StreamResponse | ToolStreamResponse {
    if (r.type === 'tool') return r
    if (r.type === 'text') return { type: 'text', content: r.content }
    throw new Error(`cannot convert error to stream: ${r.message}`)
  }

  private streamToNonStream(s: StreamResponse | ToolStreamResponse): NonStreamResponse {
    if (s.type === 'tool') return s
    return { type: 'text', content: s.content }
  }

  private writeSse(res: ServerResponse, payload: StreamResponse | ToolStreamResponse, body: any): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const lines: string[] = []
    const push = (obj: unknown) => lines.push(`data: ${JSON.stringify(obj)}`)

    const toolCalls = payload.type === 'tool' ? payload.calls : []
    const text = payload.type === 'text' ? payload.content : (payload.content ?? '')
    const reasoning = payload.type === 'text' ? payload.reasoning : undefined

    if (reasoning) {
      for (const ch of chunkText(reasoning)) {
        push({ choices: [{ delta: { reasoning_content: ch } }] })
      }
    }
    if (text) {
      for (const ch of chunkText(text)) {
        push({ choices: [{ delta: { content: ch } }] })
      }
    }
    toolCalls.forEach((c, i) => {
      push({
        choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: '' } }] } }],
      })
      const args = chunkText(c.arguments, 8)
      for (const part of args) {
        push({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: part } }] } }] })
      }
    })
    if (body?.stream_options?.include_usage) {
      push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })
    }
    lines.push('data: [DONE]')
    res.end(`${lines.join('\n')}\n`)
  }
}

/** 把文本切成 n 字符的块（模拟增量） */
function chunkText(text: string, size = 3): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out.length > 0 ? out : ['']
}

export async function startMockLlmServer(
  routes: Record<string, { stream?: StreamResponse | ToolStreamResponse; nonStream?: NonStreamResponse; fail?: FailPolicy }>,
): Promise<MockLlmServerHandle> {
  const server = new MockLlmServer(new Map(Object.entries(routes).map(([k, v]) => [k, { ...v }])))
  const http = createServer((req, res) => server.handle(req, res))
  await once(http.listen(0, '127.0.0.1'), 'listening')
  const addr = http.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests: server.requests,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  }
}
