import { TICK_COUNT, INTERVAL_MS, type ScheduledTask } from './types.js'

/**
 * 时间轮（对齐设计文档 11.1，复刻 Rust 版 27 槽位）。
 *
 * - 每秒 tick 一次，当前槽到点的任务（rotation <= nextRotation）返回给 engine 执行
 * - 延迟超过一轮（> TICK_COUNT 秒）的任务靠 rotation 标记延后触发
 * - 精度 1 秒，满足定时任务场景；漂移由 engine 用 Date.now() 校准
 */

interface WheelEntry {
  task: ScheduledTask
  rotation: number
}

export class TimeWheel {
  private buckets: (WheelEntry | null)[][] = Array.from({ length: TICK_COUNT }, () => [null])
  private currentTick = 0
  private nextRotation = 1

  /** 当前槽位数（测试用） */
  get tickCount(): number {
    return TICK_COUNT
  }

  /**
   * 排程任务（绝对时刻语义：abs = 已走 tick 数 + 目标 tick 数）。
   * 设计文档 11.1 的相对公式对 >TICK_COUNT 秒的延迟会在首次弹出时丢弃条目，
   * 此处用绝对时刻修正：rotation = 1 + floor(abs / TICK_COUNT)，槽位 = abs % TICK_COUNT。
   */
  schedule(task: ScheduledTask, delayMs: number): number {
    const targetTick = Math.max(1, Math.ceil(delayMs / INTERVAL_MS))
    const abs = this.ticksSoFar() + targetTick
    const rotation = 1 + Math.floor(abs / TICK_COUNT)
    const bucketIdx = abs % TICK_COUNT
    this.buckets[bucketIdx]!.push({ task, rotation })
    task.rotation = rotation
    return rotation
  }

  /**
   * 取走当前槽到点的任务（rotation <= nextRotation）。
   * 未到期的条目（跨轮次）绝对时刻不变，重新入对应槽，不丢弃。
   */
  tick(): ScheduledTask[] {
    const bucketIdx = this.currentTick
    const current = this.buckets[bucketIdx]!
    this.buckets[bucketIdx] = [null]
    this.currentTick = (this.currentTick + 1) % TICK_COUNT
    if (this.currentTick === 0) this.nextRotation++

    const due: ScheduledTask[] = []
    for (const entry of current) {
      if (!entry) continue
      if (entry.rotation <= this.nextRotation) {
        due.push(entry.task)
      } else {
        // 跨轮次未到期：还原绝对时刻，重排到正确槽（rotation 不变）
        const abs = (entry.rotation - 1) * TICK_COUNT + bucketIdx
        const remaining = abs - this.ticksSoFar()
        const newBucket = (this.currentTick + remaining) % TICK_COUNT
        this.buckets[newBucket]!.push(entry)
      }
    }
    return due
  }

  /** 自 wheel 创建以来已走的 tick 数 */
  private ticksSoFar(): number {
    return (this.nextRotation - 1) * TICK_COUNT + this.currentTick
  }

  /** 清空全部槽位（stop 用） */
  clear(): void {
    this.buckets = Array.from({ length: TICK_COUNT }, () => [null])
    this.currentTick = 0
    this.nextRotation = 1
  }

  /** 当前排程中的任务总数（测试/调试） */
  pendingCount(): number {
    let n = 0
    for (const bucket of this.buckets) {
      for (const e of bucket) if (e) n++
    }
    return n
  }
}
