import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskManager, createTaskManager } from '../../src/tools/task/task-manager.js'
import { taskStatusHandler, taskStatusSpec } from '../../src/tools/task/task-status.js'
import { pauseTaskHandler, pauseTaskSpec } from '../../src/tools/task/pause-task.js'
import { resumeTaskHandler, resumeTaskSpec } from '../../src/tools/task/resume-task.js'
import { cancelTaskHandler, cancelTaskSpec } from '../../src/tools/task/cancel-task.js'
import { ReadCache } from '../../src/tools/cache.js'

/**
 * Phase 4 任务管理测试：TaskManager 状态机 + 4 个 task 工具。
 */

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-task-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function toolCtx() {
  return {
    workingDir: dir,
    cache: new ReadCache(),
    sessionId: 'sess-task-test',
  }
}

describe('TaskManager 状态机', () => {
  it('createTask 登记 running 并持久化', async () => {
    const tm = new TaskManager(dir)
    const id = await tm.createTask('实现登录功能', 'sess-a')
    const task = await tm.get(id)
    expect(task).toBeDefined()
    expect(task!.status).toBe('running')
    expect(task!.description).toBe('实现登录功能')

    // 新实例从磁盘恢复
    const tm2 = createTaskManager(dir)
    const reloaded = await tm2.get(id)
    expect(reloaded).toBeDefined()
    expect(reloaded!.status).toBe('running')
  })

  it('pause：running → paused（abort 被触发）', async () => {
    const tm = new TaskManager(dir)
    const id = await tm.createTask('暂停测试', 'sess-b')
    const controller = new AbortController()
    tm.bindAbort(id, controller)

    const task = await tm.pause(id)
    expect(task!.status).toBe('paused')
    expect(controller.signal.aborted).toBe(true)
    expect(tm.aborts).toBeDefined()
  })

  it('pause 非 running 任务不改变状态', async () => {
    const tm = new TaskManager(dir)
    const id = await tm.createTask('已暂停的任务', 'sess-b')
    await tm.pause(id)
    const task = await tm.pause(id) // 再次 pause
    expect(task!.status).toBe('paused')
  })

  it('resume：paused → running', async () => {
    const tm = new TaskManager(dir)
    const id = await tm.createTask('恢复测试', 'sess-c')
    await tm.pause(id)
    const task = await tm.resume(id)
    expect(task!.status).toBe('running')
  })

  it('cancel：任意 → cancelled（含 abort）', async () => {
    const tm = new TaskManager(dir)
    const id = await tm.createTask('取消测试', 'sess-d')
    const controller = new AbortController()
    tm.bindAbort(id, controller)

    const task = await tm.cancel(id)
    expect(task!.status).toBe('cancelled')
    expect(controller.signal.aborted).toBe(true)

    // 重复取消幂等
    const again = await tm.cancel(id)
    expect(again!.status).toBe('cancelled')
  })

  it('updateTask 更新 iterations/note', async () => {
    const tm = new TaskManager(dir)
    const id = await tm.createTask('更新测试', 'sess-e')
    await tm.updateTask(id, { iterations: 5, note: '卡在审批' })
    const task = await tm.get(id)
    expect(task!.iterations).toBe(5)
    expect(task!.note).toBe('卡在审批')
  })

  it('list 过滤状态/会话，新在前', async () => {
    const tm = new TaskManager(dir)
    const running = await tm.list({ status: 'running' })
    expect(running.every((t) => t.status === 'running')).toBe(true)
    const bySession = await tm.list({ sessionId: 'sess-d' })
    expect(bySession.every((t) => t.sessionId === 'sess-d')).toBe(true)
    expect(bySession.length).toBeGreaterThan(0)
  })

  it('损坏文件重置为空', async () => {
    const sub = path.join(dir, 'corrupt')
    await (await import('node:fs/promises')).mkdir(sub, { recursive: true })
    await (await import('node:fs/promises')).writeFile(
      path.join(sub, '.dev-assistant-tasks.json'),
      '{broken',
      'utf8',
    )
    const tm = new TaskManager(sub)
    const tasks = await tm.list()
    expect(tasks).toEqual([])
    // 之后可正常写入
    const id = await tm.createTask('修复后写入', 'sess-f')
    expect((await tm.get(id))!.status).toBe('running')
  })
})

describe('task 工具 specs', () => {
  it('命名与危险级别', () => {
    expect(taskStatusSpec.name).toBe('task_status')
    expect(taskStatusSpec.dangerLevel).toBe('low')
    expect(pauseTaskSpec.name).toBe('pause_task')
    expect(pauseTaskSpec.dangerLevel).toBe('medium')
    expect(resumeTaskSpec.name).toBe('resume_task')
    expect(resumeTaskSpec.dangerLevel).toBe('medium')
    expect(cancelTaskSpec.name).toBe('cancel_task')
    expect(cancelTaskSpec.dangerLevel).toBe('high')
  })
})

describe('task 工具 handlers', () => {
  it('task_status 无 id 列出最近任务', async () => {
    const r = await taskStatusHandler({ arguments: {} }, toolCtx())
    expect(r.success).toBe(true)
    expect(r.content).toContain('任务记录')
  })

  it('task_status 查单个任务', async () => {
    const tm = createTaskManager(dir)
    const id = await tm.createTask('工具查询测试', 'sess-task-test')
    const r = await taskStatusHandler({ arguments: { id } }, toolCtx())
    expect(r.success).toBe(true)
    expect(r.content).toContain(id)
    expect(r.content).toContain('running')
  })

  it('task_status 未知 id 报错', async () => {
    const r = await taskStatusHandler({ arguments: { id: 'task-nope' } }, toolCtx())
    expect(r.success).toBe(false)
    expect(r.content).toContain('未找到')
  })

  it('pause_task 缺省取当前会话最近运行任务', async () => {
    const tm = createTaskManager(dir)
    await tm.createTask('待暂停任务', 'sess-task-test')
    const r = await pauseTaskHandler({ arguments: {} }, toolCtx())
    expect(r.success).toBe(true)
    expect(r.content).toContain('已暂停')
  })

  it('resume_task 恢复已暂停任务', async () => {
    const tm = createTaskManager(dir)
    const running = await tm.list({ status: 'paused', sessionId: 'sess-task-test' })
    if (running.length === 0) {
      // 先造一个已暂停任务
      const id = await tm.createTask('先暂停再恢复', 'sess-task-test')
      await tm.pause(id)
    }
    const r = await resumeTaskHandler({ arguments: {} }, toolCtx())
    expect(r.success).toBe(true)
    expect(r.content).toContain('已恢复')
  })

  it('cancel_task 取消任务', async () => {
    const tm = createTaskManager(dir)
    const id = await tm.createTask('待取消任务', 'sess-task-test')
    const r = await cancelTaskHandler({ arguments: { id } }, toolCtx())
    expect(r.success).toBe(true)
    expect(r.content).toContain('已取消')
    // handler 内部新建 TaskManager 并从磁盘读写；用新实例验证持久化结果
    const tm2 = createTaskManager(dir)
    const task = await tm2.get(id)
    expect(task!.status).toBe('cancelled')
  })

  it('pause/resume/cancel 无目标任务时报错', async () => {
    const empty = path.join(dir, 'empty-session')
    await (await import('node:fs/promises')).mkdir(empty, { recursive: true })
    const ctxEmpty = { ...toolCtx(), workingDir: empty, sessionId: 'sess-none' }
    expect((await pauseTaskHandler({ arguments: {} }, ctxEmpty)).success).toBe(false)
    expect((await resumeTaskHandler({ arguments: {} }, ctxEmpty)).success).toBe(false)
    expect((await cancelTaskHandler({ arguments: {} }, ctxEmpty)).success).toBe(false)
  })
})
