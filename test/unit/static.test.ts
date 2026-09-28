import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { indexPageHandler, staticFileHandler } from '../../src/web/static.js'
import type { Request, Response } from 'express'

/**
 * 静态资源 handler 单测：直接调用 handler（express 层挂载在 server.test.ts 覆盖）。
 * - indexPageHandler：无托管目录 → 内置页；有 .dev-assistant-web/index.html → 自定义页
 * - staticFileHandler：空路径/路径穿越 → 400；越界解析或不存在 → 404；正常 → sendFile
 */

let dir: string
const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

async function setup(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'dev-assistant-static-'))
  dirs.push(d)
  return d
}

function makeReq(pathname: string): Request {
  return { path: pathname } as unknown as Request
}

type MockRes = Response & {
  status: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  type: ReturnType<typeof vi.fn>
  sendFile: ReturnType<typeof vi.fn>
}

function makeRes(): MockRes {
  const res: Record<string, unknown> = {}
  res.status = vi.fn(() => res)
  res.end = vi.fn(() => res)
  res.send = vi.fn(() => res)
  res.type = vi.fn(() => res)
  res.sendFile = vi.fn(() => res)
  return res as unknown as MockRes
}

const webDir = (d: string): string => path.join(d, '.dev-assistant-web')

// ---------------------------------------------------------------------------

describe('indexPageHandler', () => {
  it('无托管目录 → 内置最小聊天页', async () => {
    dir = await setup()
    const res = makeRes()
    indexPageHandler(dir)(makeReq('/'), res)
    expect(res.type).toHaveBeenCalledWith('html')
    const page = res.send.mock.calls[0]?.[0] as string
    expect(page).toContain('<!doctype html>')
    expect(page).toContain('dev-assistant')
    expect(page).toContain('/ws/chat')
  })

  it('存在 .dev-assistant-web/index.html → 返回自定义页内容', async () => {
    dir = await setup()
    await mkdir(webDir(dir), { recursive: true })
    await writeFile(path.join(webDir(dir), 'index.html'), '<h1>自定义前端</h1>', 'utf8')
    const res = makeRes()
    indexPageHandler(dir)(makeReq('/'), res)
    expect(res.send).toHaveBeenCalledWith('<h1>自定义前端</h1>')
  })
})

describe('staticFileHandler', () => {
  it('空路径 → 400 bad path', async () => {
    dir = await setup()
    const res = makeRes()
    staticFileHandler(dir)(makeReq(''), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.end).toHaveBeenCalledWith('bad path')
  })

  it('含 .. 的路径 → 400 bad path', async () => {
    dir = await setup()
    const res = makeRes()
    staticFileHandler(dir)(makeReq('/../etc/passwd'), res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.end).toHaveBeenCalledWith('bad path')
  })

  it('存在的文件 → sendFile 解析后的绝对路径', async () => {
    dir = await setup()
    await mkdir(webDir(dir), { recursive: true })
    await writeFile(path.join(webDir(dir), 'app.js'), 'console.log(1)', 'utf8')
    const res = makeRes()
    staticFileHandler(dir)(makeReq('/app.js'), res)
    expect(res.sendFile).toHaveBeenCalledWith(path.join(webDir(dir), 'app.js'))
  })

  it('不存在的文件 → 404 not found', async () => {
    dir = await setup()
    const res = makeRes()
    staticFileHandler(dir)(makeReq('/nope.js'), res)
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.end).toHaveBeenCalledWith('not found')
  })

  it('解析结果逃逸托管目录（绝对路径重置）→ 404', async () => {
    dir = await setup()
    const res = makeRes()
    // path.resolve(root, '/etc/passwd') → '/etc/passwd'，不在托管目录内
    staticFileHandler(dir)(makeReq('/etc/passwd'), res)
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.end).toHaveBeenCalledWith('not found')
    expect(res.sendFile).not.toHaveBeenCalled()
  })
})
