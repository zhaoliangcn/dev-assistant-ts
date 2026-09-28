import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureLogger, log, setLogLevel } from '../../src/utils/logger.js'

/**
 * logger.ts 单测：mock pino（避免 TTY 分支真的启动 pino-pretty worker），
 * 覆盖默认实例创建、wrap 的双签名转发、configureLogger 重建（含 TTY/NO_COLOR 分支）
 * 与 setLogLevel 热切换。
 */

interface PinoStub {
  level: string
  debug: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  pino: vi.fn((_options?: unknown) => ({
    level: 'info',
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

vi.mock('pino', () => ({ default: mocks.pino }))

function stubAt(callIndex: number): PinoStub {
  return mocks.pino.mock.results[callIndex]?.value as PinoStub
}

function currentStub(): PinoStub {
  return stubAt(mocks.pino.mock.calls.length - 1)!
}

// isTTY / NO_COLOR 操纵与恢复
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
const originalNoColor = process.env.NO_COLOR
function setTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
}
afterEach(() => {
  if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
  else delete (process.stdout as { isTTY?: unknown }).isTTY
  if (originalNoColor === undefined) delete process.env.NO_COLOR
  else process.env.NO_COLOR = originalNoColor
  configureLogger(false) // 复位到默认实例
})

describe('logger 默认实例与 wrap 转发', () => {
  it('模块加载即创建 info 级实例；非 TTY 不启用 pino-pretty', () => {
    expect(mocks.pino).toHaveBeenCalledTimes(1)
    const options = mocks.pino.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options).toEqual({ level: 'info', base: undefined })
    expect('transport' in options).toBe(false)
  })

  it('无 obj：p(msg)；有 obj：p(obj, msg)', () => {
    const stub = currentStub()
    log.debug('调试信息')
    log.info('普通信息')
    log.warn('警告', { scope: 'hooks' })
    log.error('出错', { detail: 'x' })
    expect(stub.debug).toHaveBeenCalledWith('调试信息')
    expect(stub.info).toHaveBeenCalledWith('普通信息')
    expect(stub.warn).toHaveBeenCalledWith({ scope: 'hooks' }, '警告')
    expect(stub.error).toHaveBeenCalledWith({ detail: 'x' }, '出错')
  })
})

describe('configureLogger 重建', () => {
  it('verbose=true → debug 级；TTY 且无 NO_COLOR → pino-pretty transport；log 换绑新实例', () => {
    const oldStub = currentStub()
    const callsBefore = mocks.pino.mock.calls.length
    setTty(true)
    delete process.env.NO_COLOR

    configureLogger(true)

    expect(mocks.pino).toHaveBeenCalledTimes(callsBefore + 1)
    const options = mocks.pino.mock.calls[mocks.pino.mock.calls.length - 1]?.[0] as {
      level: string
      base: undefined
      transport?: { target: string; options: Record<string, unknown> }
    }
    expect(options.level).toBe('debug')
    expect(options.base).toBeUndefined()
    expect(options.transport).toEqual({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
    })
    // ESM live binding：log 指向新包装，旧实例不再接收调用
    log.info('走新实例')
    expect(currentStub().info).toHaveBeenCalledWith('走新实例')
    expect(oldStub.info).not.toHaveBeenCalled()
  })

  it('NO_COLOR 环境变量禁用 pino-pretty（即使 TTY）', () => {
    setTty(true)
    process.env.NO_COLOR = '1'
    configureLogger(false)
    const options = mocks.pino.mock.calls[mocks.pino.mock.calls.length - 1]?.[0] as Record<string, unknown>
    expect(options.level).toBe('info')
    expect('transport' in options).toBe(false)
  })

  it('非 TTY 时 verbose=true 也不启用 transport', () => {
    setTty(undefined)
    delete process.env.NO_COLOR
    configureLogger(true)
    const options = mocks.pino.mock.calls[mocks.pino.mock.calls.length - 1]?.[0] as Record<string, unknown>
    expect(options.level).toBe('debug')
    expect('transport' in options).toBe(false)
  })
})

describe('setLogLevel 热切换', () => {
  it('直接修改当前实例级别', () => {
    const stub = currentStub()
    setLogLevel('silent')
    expect(stub.level).toBe('silent')
    setLogLevel('debug')
    expect(stub.level).toBe('debug')
  })
})
