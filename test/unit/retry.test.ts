import { describe, expect, it, vi } from 'vitest'
import {
  classifyError,
  computeDelay,
  retryWithBackoff,
  MAX_RETRIES,
  NETWORK_MAX_RETRIES,
  BASE_DELAY_MS,
  MAX_DELAY,
} from '../../src/llm/retry.js'
import { AppError } from '../../src/utils/error.js'

describe('classifyError', () => {
  it('429 → transient', () => {
    expect(classifyError(AppError.Llm('x', { status: 429 }))).toBe('transient')
  })
  it('500/502/503 → transient', () => {
    for (const s of [500, 502, 503]) {
      expect(classifyError(AppError.Llm('x', { status: s }))).toBe('transient')
    }
  })
  it('连接错误 → network', () => {
    expect(classifyError(AppError.Llm('x', { connect: true }))).toBe('network')
  })
  it('400 → fatal', () => {
    expect(classifyError(AppError.Llm('x', { status: 400 }))).toBe('fatal')
  })
  it('无状态 → fatal', () => {
    expect(classifyError(AppError.Llm('x'))).toBe('fatal')
  })
})

describe('computeDelay', () => {
  it('transient 尊重 Retry-After（≤ 上限）', () => {
    const err = AppError.Llm('x', { status: 429, retryAfterMs: 3500 })
    expect(computeDelay('transient', err, 1)).toBe(3500)
  })
  it('transient Retry-After 超过上限时改用指数退避', () => {
    const err = AppError.Llm('x', { status: 429, retryAfterMs: MAX_DELAY + 1 })
    const d = computeDelay('transient', err, 1)
    expect(d).toBeGreaterThanOrEqual(BASE_DELAY_MS)
    expect(d).toBeLessThanOrEqual(BASE_DELAY_MS * 1.25 + 1)
  })
  it('transient 指数退避 + 抖动', () => {
    const err = AppError.Llm('x', { status: 500 })
    const d1 = computeDelay('transient', err, 1)
    const d2 = computeDelay('transient', err, 2)
    expect(d1).toBeGreaterThanOrEqual(BASE_DELAY_MS)
    expect(d1).toBeLessThanOrEqual(BASE_DELAY_MS * 1.25 + 1)
    expect(d2).toBeGreaterThanOrEqual(BASE_DELAY_MS * 2)
    expect(d2).toBeLessThanOrEqual(BASE_DELAY_MS * 2 * 1.25 + 1)
  })
  it('transient 封顶 MAX_DELAY', () => {
    const err = AppError.Llm('x', { status: 500 })
    expect(computeDelay('transient', err, 10)).toBeLessThanOrEqual(MAX_DELAY)
  })
  it('network 快速退避', () => {
    const err = AppError.Llm('x', { connect: true })
    expect(computeDelay('network', err, 1)).toBe(500)
    expect(computeDelay('network', err, 2)).toBe(1000)
    expect(computeDelay('network', err, 5)).toBeLessThanOrEqual(5000)
  })
  it('fatal → 0', () => {
    expect(computeDelay('fatal', AppError.Llm('x', { status: 400 }), 1)).toBe(0)
  })
})

describe('retryWithBackoff', () => {
  it('成功时直接返回', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    await expect(retryWithBackoff(fn, { delayFn: vi.fn() })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('429 重试 MAX_RETRIES 次后成功', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(AppError.Llm('x', { status: 429 }))
      .mockRejectedValueOnce(AppError.Llm('x', { status: 500 }))
      .mockResolvedValue('recovered')
    await expect(
      retryWithBackoff(fn, { delayFn: vi.fn().mockResolvedValue(undefined) }),
    ).resolves.toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('transient 超过 MAX_RETRIES 次后抛出', async () => {
    const fn = vi.fn().mockRejectedValue(AppError.Llm('x', { status: 500 }))
    await expect(
      retryWithBackoff(fn, { delayFn: vi.fn().mockResolvedValue(undefined) }),
    ).rejects.toMatchObject({ kind: 'llm', status: 500 })
    // 1 次原始 + MAX_RETRIES 次重试
    expect(fn).toHaveBeenCalledTimes(1 + MAX_RETRIES)
  })

  it('network 错误重试 NETWORK_MAX_RETRIES 次后抛出', async () => {
    const fn = vi.fn().mockRejectedValue(AppError.Llm('x', { connect: true }))
    await expect(
      retryWithBackoff(fn, { delayFn: vi.fn().mockResolvedValue(undefined) }),
    ).rejects.toMatchObject({ kind: 'llm', connect: true })
    expect(fn).toHaveBeenCalledTimes(1 + NETWORK_MAX_RETRIES)
  })

  it('fatal 错误不重试', async () => {
    const fn = vi.fn().mockRejectedValue(AppError.Llm('x', { status: 400 }))
    await expect(
      retryWithBackoff(fn, { delayFn: vi.fn().mockResolvedValue(undefined) }),
    ).rejects.toMatchObject({ status: 400 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('非 AppError 错误归一为 llm 类（fatal 不重试）', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(
      retryWithBackoff(fn, { delayFn: vi.fn().mockResolvedValue(undefined) }),
    ).rejects.toMatchObject({ kind: 'llm' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('onRetry 回调按次触发', async () => {
    const attempts: number[] = []
    const fn = vi
      .fn()
      .mockRejectedValueOnce(AppError.Llm('x', { status: 429, retryAfterMs: 100 }))
      .mockResolvedValue('ok')
    await retryWithBackoff(fn, {
      delayFn: vi.fn().mockResolvedValue(undefined),
      onRetry: (attempt) => attempts.push(attempt),
    })
    expect(attempts).toEqual([1])
  })
})
