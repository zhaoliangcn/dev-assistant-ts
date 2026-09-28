import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AppError, isAppError } from '../../src/utils/error.js'
import { ToolError } from '../../src/tools/error.js'
import { atomicWrite } from '../../src/utils/atomic-write.js'
import { sleep } from '../../src/utils/sleep.js'
import { promptConfirm } from '../../src/utils/prompt.js'
import { theme, pressureColor, dangerColor, banner } from '../../src/ui/theme.js'
import { pressureBar, renderAgentEvent } from '../../src/ui/style.js'
import type { AgentEvent } from '../../src/agent/agent.js'

/**
 * utils / ui 层纯函数测试：AppError 分类与谓词、ToolError、atomicWrite、sleep、
 * prompt 非交互兜底，以及 theme/style 的颜色映射与文本渲染。
 */

const ESC = String.fromCharCode(27)

/** 去掉 ANSI 转义序列，使断言不受 chalk 颜色开关影响 */
function plain(s: string): string {
  return s
    .split(ESC + '[')
    .map((part, i) => (i === 0 ? part : part.replace(/^[0-9;]*m/, '')))
    .join('')
}

describe('AppError 工厂与属性', () => {
  it('各静态工厂产出对应 kind 与 message', () => {
    const cases: Array<[AppError, string, string]> = [
      [AppError.Llm('限流'), 'llm', '限流'],
      [AppError.Config('缺字段'), 'config', '缺字段'],
      [AppError.Io('读失败'), 'io', '读失败'],
      [AppError.Tool('工具失败'), 'tool', '工具失败'],
      [AppError.SubagentDepthLimit(4), 'subagent', '子代理深度超限（depth=4，最大 3）'],
      [AppError.Internal('内部错误'), 'internal', '内部错误'],
    ]
    for (const [err, kind, message] of cases) {
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(AppError)
      expect(err.kind).toBe(kind)
      expect(err.message).toBe(message)
      expect(err.name).toBe('AppError')
    }
  })

  it('构造参数透传 status/connect/retryAfterMs/detail', () => {
    const err = AppError.Llm('网关错误', { status: 503, connect: true, retryAfterMs: 1500, detail: 'origin=boom' })
    expect(err.status).toBe(503)
    expect(err.connect).toBe(true)
    expect(err.retryAfterMs).toBe(1500)
    expect(err.detail).toBe('origin=boom')
  })

  it('Io/Tool/Internal 的 detail 可选参数落到 detail 字段', () => {
    expect(AppError.Io('写失败', 'ENOSPC').detail).toBe('ENOSPC')
    expect(AppError.Io('写失败').detail).toBeUndefined()
    expect(AppError.Tool('执行失败', 'exit=2').detail).toBe('exit=2')
    expect(AppError.Internal('不可能', 'ctx').detail).toBe('ctx')
  })

  it('未传 options 时附加字段全为 undefined', () => {
    const err = new AppError('config', '裸错误')
    expect(err.status).toBeUndefined()
    expect(err.connect).toBeUndefined()
    expect(err.retryAfterMs).toBeUndefined()
    expect(err.detail).toBeUndefined()
  })
})

describe('AppError 重试谓词', () => {
  it('isRateLimited 仅在 status=429 时为真', () => {
    expect(AppError.Llm('a', { status: 429 }).isRateLimited()).toBe(true)
    expect(AppError.Llm('b', { status: 500 }).isRateLimited()).toBe(false)
    expect(AppError.Llm('c').isRateLimited()).toBe(false)
  })

  it('isServerError 覆盖 5xx 且排除 4xx', () => {
    expect(AppError.Llm('a', { status: 500 }).isServerError()).toBe(true)
    expect(AppError.Llm('b', { status: 503 }).isServerError()).toBe(true)
    expect(AppError.Llm('c', { status: 499 }).isServerError()).toBe(false)
    expect(AppError.Llm('d', { status: 429 }).isServerError()).toBe(false)
    expect(AppError.Llm('e').isServerError()).toBe(false)
  })

  it('isConnectError 只在 connect=true 时为真', () => {
    expect(AppError.Llm('a', { connect: true }).isConnectError()).toBe(true)
    expect(AppError.Llm('b', { connect: false }).isConnectError()).toBe(false)
    expect(AppError.Llm('c').isConnectError()).toBe(false)
  })

  it('retryAfter 无 Retry-After 时返回 null 而非 undefined', () => {
    expect(AppError.Llm('a', { retryAfterMs: 2000 }).retryAfter()).toBe(2000)
    expect(AppError.Llm('b').retryAfter()).toBeNull()
    expect(AppError.Llm('c', { retryAfterMs: 0 }).retryAfter()).toBe(0)
  })

  it('isAppError 类型守卫只认 AppError 实例', () => {
    expect(isAppError(AppError.Io('x'))).toBe(true)
    expect(isAppError(new Error('x'))).toBe(false)
    expect(isAppError('x')).toBe(false)
    expect(isAppError(undefined)).toBe(false)
    expect(isAppError(null)).toBe(false)
  })
})

describe('ToolError', () => {
  it('默认类别为 permanent，可用第三参覆盖', () => {
    const err = new ToolError('坏了')
    expect(err.name).toBe('ToolError')
    expect(err.category).toBe('permanent')
    expect(new ToolError('坏了', 'llm').category).toBe('llm')
    expect(err).toBeInstanceOf(Error)
  })

  it('静态工厂 transient/permanent 语义正确', () => {
    const t = ToolError.transient('网络抖动')
    expect(t.category).toBe('transient')
    expect(t.message).toBe('网络抖动')
    expect(ToolError.permanent('参数非法').category).toBe('permanent')
    expect(t.name).toBe('ToolError')
  })
})

describe('sleep', () => {
  it('按给定毫秒数 resolve 且返回 undefined', async () => {
    const started = Date.now()
    const result = await sleep(20)
    expect(result).toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })

  it('sleep(0) 立即让出事件循环', async () => {
    const order: string[] = []
    void sleep(0).then(() => order.push('sleep'))
    order.push('sync')
    await Promise.resolve()
    await sleep(1)
    expect(order).toEqual(['sync', 'sleep'])
  })
})

describe('atomicWrite', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-utils-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** 目录里是否存在 .tmp- 残留文件 */
  async function tmpResidue(): Promise<string[]> {
    const entries = await readdir(dir)
    return entries.filter((name) => name.includes('.tmp-'))
  }

  it('目标父目录不存在时递归创建并写入内容', async () => {
    const target = path.join(dir, 'nested/deeper/a.txt')
    await atomicWrite(target, '第一版内容\n')
    expect(await readFile(target, 'utf8')).toBe('第一版内容\n')
  })

  it('覆盖已有文件且不追加', async () => {
    const target = path.join(dir, 'cover.txt')
    await atomicWrite(target, 'x'.repeat(5000))
    await atomicWrite(target, '短')
    expect(await readFile(target, 'utf8')).toBe('短')
  })

  it('允许写入空内容（文件存在且长度为 0）', async () => {
    const target = path.join(dir, 'empty.txt')
    await atomicWrite(target, '')
    expect(existsSync(target)).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('')
  })

  it('UTF-8 多字节内容按字节完整落盘', async () => {
    const target = path.join(dir, 'utf8.md')
    const content = '# 标题\n中文·emoji 🚀 结尾\n'
    await atomicWrite(target, content)
    expect(await readFile(target, 'utf8')).toBe(content)
  })

  it('写入成功与失败后都不残留临时文件', async () => {
    await atomicWrite(path.join(dir, 'clean.txt'), 'ok')
    expect(await tmpResidue()).toEqual([])

    // 目标名是一个已存在目录 → rename 必然失败
    const blocked = path.join(dir, 'blocked')
    await mkdir(blocked, { recursive: true })
    await writeFile(path.join(blocked, 'inner.txt'), '占用')
    await expect(atomicWrite(blocked, '写不进去')).rejects.toThrow()
    expect(await tmpResidue()).toEqual([])
    // 原目录内容不受影响
    expect(await readFile(path.join(blocked, 'inner.txt'), 'utf8')).toBe('占用')
  })

  it('并发写同一目标最终只保留一份完整内容', async () => {
    const target = path.join(dir, 'concurrent.txt')
    const big = '段落\n'.repeat(2000)
    await Promise.all([atomicWrite(target, big), atomicWrite(target, 'B')])
    const final = await readFile(target, 'utf8')
    expect(final === big || final === 'B').toBe(true)
    expect(await tmpResidue()).toEqual([])
  })
})

describe('prompt 非交互兜底', () => {
  it('非 TTY 时 promptConfirm 直接拒绝并打印说明', async () => {
    const original = process.stdin.isTTY
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    try {
      await expect(promptConfirm('允许执行 rm -rf 吗？')).resolves.toBe(false)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0]?.[0]).toContain('非交互环境')
    } finally {
      delete (process.stdin as { isTTY?: unknown }).isTTY
      if (original !== undefined) {
        process.stdin.isTTY = original
      }
      errorSpy.mockRestore()
    }
  })
})

describe('ui theme 颜色映射', () => {
  it('theme 收敛为 ANSI 16 色名常量', () => {
    expect(theme).toEqual({
      primary: 'cyan',
      user: 'green',
      assistant: 'white',
      tool: 'magenta',
      dim: 'gray',
      warn: 'yellow',
      error: 'red',
      success: 'green',
      approval: 'yellow',
    })
  })

  it('pressureColor 按压力级别映射（low→绿 / critical→红）', () => {
    expect(pressureColor('low')).toBe('green')
    expect(pressureColor('medium')).toBe('cyan')
    expect(pressureColor('high')).toBe('yellow')
    expect(pressureColor('critical')).toBe('red')
  })

  it('dangerColor 与 pressureColor 仅在 low 档不同', () => {
    expect(dangerColor('low')).toBe('gray')
    for (const level of ['medium', 'high', 'critical'] as const) {
      expect(dangerColor(level)).toBe(pressureColor(level))
    }
  })

  it('banner 含品牌名与快捷键提示', () => {
    const text = plain(banner())
    expect(text).toContain('dev-assistant')
    expect(text).toContain('/help')
    expect(text).toContain('/quit')
  })
})

describe('pressureBar', () => {
  it('默认宽度 10 渲染填充与百分比', () => {
    expect(plain(pressureBar(0))).toBe(`${'░'.repeat(10)} 0%`)
    expect(plain(pressureBar(0.5))).toBe(`${'█'.repeat(5)}${'░'.repeat(5)} 50%`)
    expect(plain(pressureBar(1))).toBe(`${'█'.repeat(10)} 100%`)
  })

  it('支持自定义宽度并按四舍五入取整', () => {
    expect(plain(pressureBar(0.25, 8))).toBe(`${'█'.repeat(2)}${'░'.repeat(6)} 25%`)
    expect(plain(pressureBar(0.04, 10))).toBe(`${'░'.repeat(10)} 4%`)
    expect(plain(pressureBar(0.06, 10))).toBe(`${'█'.repeat(1)}${'░'.repeat(9)} 6%`)
  })

  it('比例超过 1 时条形封顶但百分比原样输出', () => {
    expect(plain(pressureBar(1.5))).toBe(`${'█'.repeat(10)} 150%`)
  })
})

describe('renderAgentEvent 纯文本渲染', () => {
  let writes: string[]
  let original: typeof process.stdout.write

  beforeEach(() => {
    writes = []
    original = process.stdout.write
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write
  })

  afterEach(() => {
    process.stdout.write = original
  })

  function render(event: AgentEvent): void {
    renderAgentEvent(event)
  }

  /** 合并所有写入并去掉颜色码 */
  function out(): string {
    return writes.map(plain).join('')
  }

  it('assistantStreamDelta 原样输出增量文本', () => {
    render({ kind: 'assistantStreamDelta', content: '你好，世界' })
    expect(writes).toEqual(['你好，世界'])
  })

  it('reasoningDelta 输出思考文本', () => {
    render({ kind: 'reasoningDelta', content: '先看看配置' })
    expect(out()).toBe('先看看配置')
  })

  it('toolCall 输出工具名、参数与危险级别标签', () => {
    render({
      kind: 'toolCall',
      call: { id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
      security: { dangerLevel: 'high', reasons: ['固有级别: high'] },
    })
    const text = out()
    expect(text.startsWith('\n')).toBe(true)
    expect(text).toContain('read_file')
    expect(text).toContain('{"path":"a.txt"}')
    expect(text).toContain('[high]')
  })

  it('toolCall 缺少安全评估时标签回退 low，长参数截断到 100 字符', () => {
    const long = 'x'.repeat(150)
    render({ kind: 'toolCall', call: { id: 'c2', function: { name: 'exec_command', arguments: long } } })
    const text = out()
    expect(text).toContain(`${'x'.repeat(100)}…`)
    expect(text).not.toContain('x'.repeat(101))
    expect(text).toContain('[low]')
  })

  it('toolResult 成功标记 ✓ 并把换行折叠成 ⏎', () => {
    render({
      kind: 'toolResult',
      callId: 'c3',
      name: 'read_file',
      result: { success: true, content: '第一行\n第二行', restartRequested: false },
    })
    expect(out()).toContain('✓')
    expect(out()).toContain('第一行 ⏎ 第二行')
  })

  it('toolResult 失败标记 ✗ 且内容预览截断 200 字符', () => {
    render({
      kind: 'toolResult',
      callId: 'c4',
      name: 'exec_command',
      result: { success: false, content: 'a'.repeat(300), restartRequested: false, errorCategory: 'permanent' },
    })
    const text = out()
    expect(text).toContain('✗')
    expect(text).toContain('a'.repeat(200))
    expect(text).not.toContain('a'.repeat(201))
  })

  it('status 与 systemMessage 有各自前缀', () => {
    render({ kind: 'status', content: '正在压缩上下文' })
    render({ kind: 'systemMessage', content: 'preToolUse hook 阻断' })
    expect(out()).toContain('\n⏳ 正在压缩上下文')
    expect(out()).toContain('\n[hooks] preToolUse hook 阻断')
  })

  it('tokenUsage 静默不产生任何输出', () => {
    render({ kind: 'tokenUsage', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } })
    expect(writes).toEqual([])
  })
})