import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeReadline, getReadline, promptConfirm, promptText } from '../../src/utils/prompt.js'

/**
 * prompt.ts 单测：mock node:readline，用受控队列应答 question 回调，
 * 覆盖共享 readline 单例、单行输入、y/N 确认（TTY）与非 TTY 安全拒绝。
 */

const mocks = vi.hoisted(() => ({ createInterface: vi.fn() }))

vi.mock('node:readline', () => ({ createInterface: mocks.createInterface }))

type QuestionCallback = (answer: string) => void

let pendingAnswers: QuestionCallback[]
let fakeRl: { question: (query: string, cb: QuestionCallback) => void; close: ReturnType<typeof vi.fn> }

/** 模拟用户输入一行（触发最早挂起的 question 回调） */
function type(answer: string): void {
  const cb = pendingAnswers.shift()
  expect(cb, '没有等待中的 question 回调').toBeDefined()
  cb!(answer)
}

// isTTY 操纵（测试结束后恢复）
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
function setTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}
afterAll(() => {
  if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY)
  else delete (process.stdin as { isTTY?: unknown }).isTTY
})

beforeEach(() => {
  pendingAnswers = []
  fakeRl = {
    question: (_query: string, cb: QuestionCallback) => {
      pendingAnswers.push(cb)
    },
    close: vi.fn(),
  }
  mocks.createInterface.mockReset()
  mocks.createInterface.mockImplementation(() => fakeRl)
  closeReadline() // 重置模块级单例
})

afterEach(() => {
  closeReadline()
})

describe('getReadline / closeReadline', () => {
  it('共享实例：多次调用返回同一对象且只创建一次', () => {
    const first = getReadline()
    const second = getReadline()
    expect(second).toBe(first)
    expect(mocks.createInterface).toHaveBeenCalledTimes(1)
    expect(mocks.createInterface).toHaveBeenCalledWith({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    })
  })

  it('closeReadline 关闭并重置：下次创建新实例', () => {
    const first = getReadline()
    closeReadline()
    expect(fakeRl.close).toHaveBeenCalledTimes(1)
    const secondFake = { question: vi.fn(), close: vi.fn() }
    mocks.createInterface.mockImplementation(() => secondFake)
    const second = getReadline()
    expect(second).not.toBe(first)
    expect(mocks.createInterface).toHaveBeenCalledTimes(2)
  })
})

describe('promptText', () => {
  it('返回 trim 后的用户输入', async () => {
    const p = promptText('请输入路径: ')
    type('  src/utils/prompt.ts  ')
    await expect(p).resolves.toBe('src/utils/prompt.ts')
  })

  it('空输入返回空串', async () => {
    const p = promptText('随便说点什么: ')
    type('   ')
    await expect(p).resolves.toBe('')
  })

  it('连续两次提问按 FIFO 应答', async () => {
    const first = promptText('第一问: ')
    const second = promptText('第二问: ')
    type('答案一')
    type('答案二')
    await expect(first).resolves.toBe('答案一')
    await expect(second).resolves.toBe('答案二')
  })
})

describe('promptConfirm（TTY）', () => {
  beforeAll(() => setTty(true))

  it.each([
    ['y', true],
    ['Y', true],
    ['yes', true],
    ['  YES  ', true],
    ['是', true],
    ['n', false],
    ['no', false],
    ['', false],
    ['maybe', false],
  ])('输入 %j → %j', async (input, expected) => {
    const p = promptConfirm('允许执行吗？')
    type(input)
    await expect(p).resolves.toBe(expected)
  })
})

describe('promptConfirm（非 TTY）', () => {
  it('安全拒绝：不创建 readline 且输出提示', async () => {
    setTty(undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(promptConfirm('允许执行 rm -rf 吗？')).resolves.toBe(false)
      expect(mocks.createInterface).not.toHaveBeenCalled()
      expect(pendingAnswers).toHaveLength(0)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0]?.[0]).toContain('非交互环境')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
