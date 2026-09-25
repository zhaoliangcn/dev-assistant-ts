/**
 * Phase 6 冒烟：通过 dist/embed 入口（真实发布形态）验证
 * mock LLM（OpenAI 兼容 SSE）驱动 Agent 读写 vault 笔记。
 */
import { createServer } from 'node:http'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createAssistantModule } = await import(path.join(here, '..', 'dist', 'embed', 'index.js'))

// mock LLM：第一次请求返回 write_file 工具调用，之后返回文本
let requestCount = 0
let lastTools: string[] = []
const mockServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    requestCount++
    const parsed = JSON.parse(body)
    lastTools = (parsed.tools ?? []).map((t: { function: { name: string } }) => t.function.name)
    const lastMsg = parsed.messages?.[parsed.messages.length - 1]

    if (requestCount === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const args = JSON.stringify({ path: 'smoke-note.md', content: '# 冒烟\n助手写入成功\n' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_smoke', function: { name: 'write_file', arguments: args } }] } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '已写入 ' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'smoke-note.md' } }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise<void>((r) => mockServer.listen(0, '127.0.0.1', r))
const mockPort = (mockServer.address() as { port: number }).port

const vault = await mkdtemp(path.join(tmpdir(), 'phase6-smoke-'))
await writeFile(path.join(vault, 'readme.md'), '# vault\n', 'utf8')

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failed++
}

const mod = createAssistantModule()
const events = []
mod.on('event', (e) => events.push(e.kind))

try {
  await mod.start({
    workingDir: vault,
    models: [
      { name: 'mock', provider: 'openai', apiUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'sk-smoke', model: 'mock-1' },
    ],
    approvalEnabled: false,
    disabledTools: ['exec_command', 'run_hook'],
    schedulerEnabled: true,
  })
  check('start 后 running', mod.getStatus().running === true)
  check('providerNames', JSON.stringify(mod.providerNames()) === '["mock"]')

  const result = await mod.run('写一个冒烟笔记')
  check('run 成功', result.success === true, result.error ?? '')
  check('最终回复', result.message === '已写入 smoke-note.md', result.message)
  check('事件含 toolCall', events.includes('toolCall'))
  check('事件含 toolResult', events.includes('toolResult'))
  check(
    'exec_command/run_hook 已从工具面裁剪',
    lastTools.length > 0 && !lastTools.includes('exec_command') && !lastTools.includes('run_hook'),
    `tools=${lastTools.length}`,
  )

  const note = await readFile(path.join(vault, 'smoke-note.md'), 'utf8').catch(() => null)
  check('vault 笔记已写入', note === '# 冒烟\n助手写入成功\n', JSON.stringify(note))
  const readme = await readFile(path.join(vault, 'readme.md'), 'utf8')
  check('vault 原笔记可读', readme === '# vault\n')

  check('重复 start 拒绝', await mod.start({ workingDir: vault, models: [] }).then(() => false).catch(() => true))
} catch (e) {
  failed++
  console.log('✗ 异常:', e instanceof Error ? e.message : String(e))
} finally {
  await mod.stop()
  mockServer.close()
  await rm(vault, { recursive: true, force: true })
}

check('stop 后 running=false', mod.getStatus().running === false)
console.log(failed === 0 ? '\n✓ Phase 6 冒烟全部通过' : `\n✗ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
