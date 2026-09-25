import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ToolRegistry, type ToolContext } from '../../src/tools/registry.js'
import { ReadCache } from '../../src/tools/cache.js'
import { readFileSpec, readFileHandler } from '../../src/tools/file/read.js'
import { batchReadFilesSpec, batchReadFilesHandler } from '../../src/tools/file/batch-read.js'
import { writeFileSpec, writeFileHandler } from '../../src/tools/file/write.js'
import { editFileSpec, editFileHandler } from '../../src/tools/file/edit.js'
import { readSymbolSpec, readSymbolHandler } from '../../src/tools/file/read-symbol.js'
import { globSpec, globHandler } from '../../src/tools/file/glob.js'
import { listDirectorySpec, listDirectoryHandler } from '../../src/tools/file/list-directory.js'
import { fileExistsSpec, fileExistsHandler } from '../../src/tools/file/file-exists.js'
import { execCommandSpec, execCommandHandler } from '../../src/tools/system/exec-command.js'
import { finishSpec, finishHandler } from '../../src/tools/meta/finish.js'
import { restartSpec, restartHandler } from '../../src/tools/meta/restart.js'

/**
 * 文件工具 + exec_command + meta 工具集成测试（真实文件系统 + 真实 shell）。
 */

let workDir: string
let ctx: ToolContext

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register(readFileSpec, readFileHandler)
  r.register(batchReadFilesSpec, batchReadFilesHandler)
  r.register(writeFileSpec, writeFileHandler)
  r.register(editFileSpec, editFileHandler)
  r.register(readSymbolSpec, readSymbolHandler)
  r.register(globSpec, globHandler)
  r.register(listDirectorySpec, listDirectoryHandler)
  r.register(fileExistsSpec, fileExistsHandler)
  r.register(execCommandSpec, execCommandHandler)
  r.register(finishSpec, finishHandler)
  r.register(restartSpec, restartHandler)
  return r
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-tools-'))
  ctx = { workingDir: workDir, cache: new ReadCache() }

  // 预置测试文件
  await writeFile(path.join(workDir, 'hello.txt'), 'line1\nline2\nline3\n')
  await mkdir(path.join(workDir, 'src'), { recursive: true })
  await writeFile(
    path.join(workDir, 'src', 'demo.ts'),
    [
      'export function add(a: number, b: number): number {',
      '  return a + b',
      '}',
      '',
      'export const ANSWER = 42',
      '',
      'function helper(): string {',
      "  return 'ok'",
      '}',
      '',
      'export class Calculator {',
      '  compute(x: number): number {',
      '    return add(x, 1)',
      '  }',
      '}',
      '',
    ].join('\n'),
  )
})

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

describe('registry', () => {
  it('注册全部工具并生成 schema', () => {
    const r = makeRegistry()
    const schemas = r.getToolSchemas()
    expect(schemas).toHaveLength(11)
    expect(schemas.every((s) => s.type === 'function' && s.function.name.length > 0)).toBe(true)
  })

  it('未知工具返回失败', async () => {
    const r = makeRegistry()
    const result = await r.execute('nonexistent', '{}', ctx)
    expect(result.success).toBe(false)
    expect(result.content).toContain('未知工具')
    expect(result.errorCategory).toBe('permanent')
  })

  it('参数 JSON 非法时返回失败诊断', async () => {
    const r = makeRegistry()
    const result = await r.execute('read_file', 'not json', ctx)
    expect(result.success).toBe(false)
    expect(result.content).toContain('JSON')
  })

  it('宽容解析 markdown 围栏包裹的参数', async () => {
    const r = makeRegistry()
    const result = await r.execute('read_file', '```json\n{"path": "hello.txt"}\n```', ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('line1')
  })
})

describe('read_file', () => {
  it('读取全文（带行号）', async () => {
    const r = makeRegistry()
    const result = await r.execute('read_file', JSON.stringify({ path: 'hello.txt' }), ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('line1')
    expect(result.content).toContain('line3')
  })

  it('offset/limit 分段读取', async () => {
    const r = makeRegistry()
    const result = await r.execute('read_file', JSON.stringify({ path: 'hello.txt', offset: 2, limit: 1 }), ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('line2')
    expect(result.content).not.toContain('line1\n')
    expect(result.content).toContain('共 3 行')
  })

  it('文件不存在 → 失败', async () => {
    const r = makeRegistry()
    const result = await r.execute('read_file', JSON.stringify({ path: 'nope.txt' }), ctx)
    expect(result.success).toBe(false)
    expect(result.content).toContain('不存在')
  })

  it('目录 → 失败', async () => {
    const r = makeRegistry()
    const result = await r.execute('read_file', JSON.stringify({ path: 'src' }), ctx)
    expect(result.success).toBe(false)
    expect(result.content).toContain('不是文件')
  })

  it('缓存命中提示', async () => {
    const r = makeRegistry()
    await r.execute('read_file', JSON.stringify({ path: 'hello.txt' }), ctx)
    const result = await r.execute('read_file', JSON.stringify({ path: 'hello.txt' }), ctx)
    expect(result.content).toContain('缓存命中')
  })
})

describe('write_file', () => {
  it('新建文件（含自动建目录）', async () => {
    const r = makeRegistry()
    const result = await r.execute('write_file', JSON.stringify({ path: 'nested/dir/new.txt', content: 'hello world' }), ctx)
    expect(result.success).toBe(true)
    const onDisk = await import('node:fs/promises').then((m) => m.readFile(path.join(workDir, 'nested/dir/new.txt'), 'utf8'))
    expect(onDisk).toBe('hello world')
  })

  it('覆盖已有文件', async () => {
    const r = makeRegistry()
    await r.execute('write_file', JSON.stringify({ path: 'ovr.txt', content: 'v1' }), ctx)
    const result = await r.execute('write_file', JSON.stringify({ path: 'ovr.txt', content: 'v2' }), ctx)
    expect(result.success).toBe(true)
    const onDisk = await import('node:fs/promises').then((m) => m.readFile(path.join(workDir, 'ovr.txt'), 'utf8'))
    expect(onDisk).toBe('v2')
  })

  it('缺参数 → 失败', async () => {
    const r = makeRegistry()
    const result = await r.execute('write_file', JSON.stringify({ path: 'x.txt' }), ctx)
    expect(result.success).toBe(false)
    expect(result.content).toContain('content')
  })
})

describe('edit_file', () => {
  it('唯一匹配替换成功', async () => {
    const r = makeRegistry()
    await r.execute('write_file', JSON.stringify({ path: 'editme.txt', content: 'alpha\nbeta\ngamma\n' }), ctx)
    const result = await r.execute(
      'edit_file',
      JSON.stringify({ path: 'editme.txt', old_string: 'beta', new_string: 'BETA' }),
      ctx,
    )
    expect(result.success).toBe(true)
    const onDisk = await import('node:fs/promises').then((m) => m.readFile(path.join(workDir, 'editme.txt'), 'utf8'))
    expect(onDisk).toBe('alpha\nBETA\ngamma\n')
  })

  it('未找到 → 失败且文件不变', async () => {
    const r = makeRegistry()
    await r.execute('write_file', JSON.stringify({ path: 'editme2.txt', content: 'one\ntwo\n' }), ctx)
    const result = await r.execute(
      'edit_file',
      JSON.stringify({ path: 'editme2.txt', old_string: 'missing', new_string: 'x' }),
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.content).toContain('未找到')
    const onDisk = await import('node:fs/promises').then((m) => m.readFile(path.join(workDir, 'editme2.txt'), 'utf8'))
    expect(onDisk).toBe('one\ntwo\n')
  })

  it('多处匹配（不 replace_all）→ 失败', async () => {
    const r = makeRegistry()
    await r.execute('write_file', JSON.stringify({ path: 'editme3.txt', content: 'dup dup dup\n' }), ctx)
    const result = await r.execute(
      'edit_file',
      JSON.stringify({ path: 'editme3.txt', old_string: 'dup', new_string: 'x' }),
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.content).toContain('3 次')
  })

  it('replace_all 替换全部', async () => {
    const r = makeRegistry()
    await r.execute('write_file', JSON.stringify({ path: 'editme4.txt', content: 'a a a\n' }), ctx)
    const result = await r.execute(
      'edit_file',
      JSON.stringify({ path: 'editme4.txt', old_string: 'a', new_string: 'b', replace_all: true }),
      ctx,
    )
    expect(result.success).toBe(true)
    const onDisk = await import('node:fs/promises').then((m) => m.readFile(path.join(workDir, 'editme4.txt'), 'utf8'))
    expect(onDisk).toBe('b b b\n')
  })

  it('old_string === new_string → 失败', async () => {
    const r = makeRegistry()
    const result = await r.execute(
      'edit_file',
      JSON.stringify({ path: 'editme.txt', old_string: 'alpha', new_string: 'alpha' }),
      ctx,
    )
    expect(result.success).toBe(false)
  })
})

describe('read_symbol', () => {
  it('读取 TS 函数定义', async () => {
    const r = makeRegistry()
    const result = await r.execute('read_symbol', JSON.stringify({ path: 'src/demo.ts', symbol: 'add' }), ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('export function add')
    expect(result.content).toContain('return a + b')
    expect(result.content).toContain('}')
    // 不应包含下一个符号
    expect(result.content).not.toContain('ANSWER')
  })

  it('读取类定义', async () => {
    const r = makeRegistry()
    const result = await r.execute('read_symbol', JSON.stringify({ path: 'src/demo.ts', symbol: 'Calculator' }), ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('export class Calculator')
    expect(result.content).toContain('compute')
  })

  it('读取常量定义（单行）', async () => {
    const r = makeRegistry()
    const result = await r.execute('read_symbol', JSON.stringify({ path: 'src/demo.ts', symbol: 'ANSWER' }), ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('ANSWER = 42')
  })

  it('符号不存在 → 失败', async () => {
    const r = makeRegistry()
    const result = await r.execute('read_symbol', JSON.stringify({ path: 'src/demo.ts', symbol: 'ghost' }), ctx)
    expect(result.success).toBe(false)
    expect(result.content).toContain('ghost')
    expect(result.content).toContain('声明')
  })

  it('非法符号名 → 失败', async () => {
    const r = makeRegistry()
    const result = await r.execute('read_symbol', JSON.stringify({ path: 'src/demo.ts', symbol: 'a b' }), ctx)
    expect(result.success).toBe(false)
  })
})

describe('glob / list_directory / file_exists', () => {
  it('glob 匹配 ts 文件', async () => {
    const r = makeRegistry()
    const result = await r.execute('glob', JSON.stringify({ pattern: 'src/**/*.ts' }), ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('src/demo.ts')
  })

  it('glob 多模式', async () => {
    const r = makeRegistry()
    const result = await r.execute('glob', JSON.stringify({ patterns: ['*.txt', 'src/*.ts'] }), ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('hello.txt')
    expect(result.content).toContain('src/demo.ts')
  })

  it('glob 无匹配 → 友好提示', async () => {
    const r = makeRegistry()
    const result = await r.execute('glob', JSON.stringify({ pattern: '**/*.xyz' }), ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('没有匹配')
  })

  it('list_directory 树形输出', async () => {
    const r = makeRegistry()
    const result = await r.execute('list_directory', JSON.stringify({}), ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('src/')
    expect(result.content).toContain('demo.ts')
    expect(result.content).toContain('hello.txt')
  })

  it('file_exists 存在/不存在', async () => {
    const r = makeRegistry()
    const ok = await r.execute('file_exists', JSON.stringify({ path: 'hello.txt' }), ctx)
    expect(ok.content).toContain('存在')
    const missing = await r.execute('file_exists', JSON.stringify({ path: 'ghost.txt' }), ctx)
    expect(missing.content).toContain('不存在')
  })
})

describe('batch_read_files', () => {
  it('批量读取多文件', async () => {
    const r = makeRegistry()
    const result = await r.execute(
      'batch_read_files',
      JSON.stringify({ paths: ['hello.txt', 'src/demo.ts'] }),
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('### hello.txt')
    expect(result.content).toContain('### src/demo.ts')
    expect(result.content).toContain('line1')
  })

  it('部分不存在仍返回成功文件', async () => {
    const r = makeRegistry()
    const result = await r.execute(
      'batch_read_files',
      JSON.stringify({ paths: ['hello.txt', 'ghost.txt'] }),
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('### hello.txt')
    expect(result.content).toContain('文件不存在')
  })
})

describe('exec_command', () => {
  it('成功命令返回 stdout + 退出码', async () => {
    const r = makeRegistry()
    const result = await r.execute('exec_command', JSON.stringify({ command: 'echo hello-exec' }), ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('hello-exec')
    expect(result.content).toContain('退出码: 0')
  })

  it('非 0 退出码 → 失败（含输出）', async () => {
    const r = makeRegistry()
    const result = await r.execute('exec_command', JSON.stringify({ command: 'echo boom; exit 3' }), ctx)
    expect(result.success).toBe(false)
    expect(result.content).toContain('boom')
    expect(result.content).toContain('退出码: 3')
  })

  it('allow_failure 覆盖失败标记', async () => {
    const r = makeRegistry()
    const result = await r.execute(
      'exec_command',
      JSON.stringify({ command: 'exit 2', allow_failure: true }),
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('退出码: 2')
  })

  it('超时', async () => {
    const r = makeRegistry()
    const result = await r.execute(
      'exec_command',
      JSON.stringify({ command: 'sleep 5', timeout: 1 }),
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.content).toContain('超时')
  }, 30_000)

  it('相对 cwd 参数', async () => {
    const r = makeRegistry()
    const result = await r.execute(
      'exec_command',
      JSON.stringify({ command: 'pwd', cwd: 'src' }),
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('src')
  })
})

describe('meta 工具', () => {
  it('finish 返回成功 + message', async () => {
    const r = makeRegistry()
    const result = await r.execute('finish', JSON.stringify({ message: '全部完成' }), ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('全部完成')
  })

  it('finish 缺 message → 失败', async () => {
    const r = makeRegistry()
    const result = await r.execute('finish', '{}', ctx)
    expect(result.success).toBe(false)
  })

  it('restart 返回 restartRequested=true', async () => {
    const r = makeRegistry()
    const result = await r.execute('restart', JSON.stringify({ reason: '上下文污染' }), ctx)
    expect(result.success).toBe(true)
    expect(result.restartRequested).toBe(true)
  })
})
