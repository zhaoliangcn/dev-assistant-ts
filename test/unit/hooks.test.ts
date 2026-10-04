import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseHooksConfig, loadHooksConfig, DEFAULT_HOOKS_FILE } from '../../src/hooks/config.js'
import { HookManager } from '../../src/hooks/manager.js'
import { runShell } from '../../src/hooks/shell.js'
import { runHookHandler } from '../../src/tools/meta/run-hook.js'
import { AppError } from '../../src/utils/error.js'
import { ReadCache } from '../../src/tools/cache.js'
import type { HookDefinition } from '../../src/hooks/types.js'

/**
 * Hook 子系统测试：配置解析 → HookManager 触发调度 → shell 执行器 → run_hook 工具。
 * 涉及执行的用例真实调用 `sh -c`，命令只用 POSIX 内建 + yes/head/tr，跨 macOS/Linux 可用。
 */

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-hooks-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 断言抛出的必须是 kind=config 的 AppError，并返回它以便检查消息 */
function configError(fn: () => unknown): AppError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(AppError)
    expect((e as AppError).kind).toBe('config')
    return e as AppError
  }
  throw new Error('预期抛出 AppError，实际未抛出')
}

describe('parseHooksConfig', () => {
  it('解析完整 [[hooks]] 条目（含可选字段）', () => {
    const hooks = parseHooksConfig(`
[[hooks]]
name = "notify"
event = "agent-done"
command = "echo done"

[[hooks]]
name = "lint"
event = "post-tool"
tool = "write_file"
command = "npm run lint"
timeout_secs = 5
inject_output = true
`)
    expect(hooks).toHaveLength(2)
    expect(hooks[0]).toEqual({ name: 'notify', event: 'agent-done', command: 'echo done' })
    expect(hooks[1]).toEqual({
      name: 'lint',
      event: 'post-tool',
      command: 'npm run lint',
      tool: 'write_file',
      timeoutSecs: 5,
      injectOutput: true,
    })
  })

  it('无 hooks 节时返回空列表而非报错', () => {
    expect(parseHooksConfig('')).toEqual([])
    expect(parseHooksConfig('[other]\nk = 1')).toEqual([])
  })

  it('字段首尾空白被裁剪', () => {
    const [h] = parseHooksConfig('[[hooks]]\nname = " a "\nevent = "session-start"\ncommand = " echo b "\n')
    expect(h?.name).toBe('a')
    expect(h?.command).toBe('echo b')
  })

  it('非法 TOML 报 Config 错误', () => {
    expect(configError(() => parseHooksConfig('[[hooks]\nname =')).message).toContain('TOML 解析失败')
  })

  it('条目不是表时报错并带序号', () => {
    expect(configError(() => parseHooksConfig('hooks = ["a"]')).message).toContain('第 1 条不是表')
  })

  it('缺少必填字段（name/command/空 command）分别报错', () => {
    expect(configError(() => parseHooksConfig('[[hooks]]\nevent = "agent-done"\ncommand = "x"')).message).toContain('name')
    expect(configError(() => parseHooksConfig('[[hooks]]\nname = "n"\nevent = "agent-done"')).message).toContain('command')
    expect(
      configError(() => parseHooksConfig('[[hooks]]\nname = "n"\nevent = "agent-done"\ncommand = "  "')).message,
    ).toContain('非空字符串')
  })

  it('event 取值非法时报错并列出可选值', () => {
    const msg = configError(() =>
      parseHooksConfig('[[hooks]]\nname = "n"\nevent = "on-save"\ncommand = "x"'),
    ).message
    expect(msg).toContain('取值非法: on-save')
    expect(msg).toContain('session-start, pre-tool, post-tool, agent-done')
  })

  it('timeout_secs 非正数/非数字时忽略该字段', () => {
    for (const bad of ['0', '-3', '"abc"']) {
      const [h] = parseHooksConfig(`[[hooks]]\nname = "n"\nevent = "agent-done"\ncommand = "x"\ntimeout_secs = ${bad}\n`)
      expect(h?.timeoutSecs).toBeUndefined()
    }
  })

  it('timeout_secs 小数向下取整', () => {
    const [h] = parseHooksConfig('[[hooks]]\nname = "n"\nevent = "agent-done"\ncommand = "x"\ntimeout_secs = 4.9\n')
    expect(h?.timeoutSecs).toBe(4)
  })

  it('inject_output / tool 非预期类型时忽略', () => {
    const [h] = parseHooksConfig(
      '[[hooks]]\nname = "n"\nevent = "agent-done"\ncommand = "x"\ninject_output = "yes"\ntool = 3\n',
    )
    expect(h?.injectOutput).toBeUndefined()
    expect(h?.tool).toBeUndefined()
  })
})

describe('loadHooksConfig', () => {
  it('文件不存在返回空列表', async () => {
    expect(await loadHooksConfig(path.join(dir, 'no-such-dir'))).toEqual([])
  })

  it('读取工作目录下的默认文件名', async () => {
    const wd = path.join(dir, 'wd-default')
    await mkdir(wd, { recursive: true })
    await writeFile(path.join(wd, DEFAULT_HOOKS_FILE), '[[hooks]]\nname = "n"\nevent = "agent-done"\ncommand = "echo hi"\n')
    const hooks = await loadHooksConfig(wd)
    expect(hooks).toHaveLength(1)
    expect(hooks[0]?.name).toBe('n')
  })

  it('explicitPath 优先于工作目录默认文件', async () => {
    const wd = path.join(dir, 'wd-explicit')
    await mkdir(wd, { recursive: true })
    const target = path.join(dir, 'custom-hooks.toml')
    await writeFile(target, '[[hooks]]\nname = "explicit"\nevent = "session-start"\ncommand = "echo c"\n')
    const hooks = await loadHooksConfig(wd, target)
    expect(hooks[0]?.name).toBe('explicit')
  })

  it('路径是目录（EISDIR）时抛 Config 错误', async () => {
    const asDir = path.join(dir, 'a-dir.toml')
    await mkdir(path.join(asDir, 'inner'), { recursive: true })
    await expect(loadHooksConfig(dir, asDir)).rejects.toThrow(/无法读取 hook 配置/)
  })
})

describe('runShell', () => {
  it('成功命令：exitCode 0 + stdout 捕获', async () => {
    const r = await runShell({ command: 'echo hello', cwd: dir })
    expect(r).toMatchObject({ success: true, stdout: 'hello\n', stderr: '', exitCode: 0, timedOut: false, aborted: false })
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('非零退出：success=false 但保留 stdout/stderr', async () => {
    const r = await runShell({ command: 'echo out; echo err 1>&2; exit 3', cwd: dir })
    expect(r.success).toBe(false)
    expect(r.exitCode).toBe(3)
    expect(r.stdout).toBe('out\n')
    expect(r.stderr).toBe('err\n')
  })

  it('自定义 env 注入生效，且继承 process.env', async () => {
    process.env.DEV_ASSISTANT_TEST_INHERIT = 'inherited-ok'
    try {
      const r = await runShell({
        command: 'printf "%s|%s|%s" "$DEV_ASSISTANT_EVENT" "$DEV_ASSISTANT_TOOL" "$DEV_ASSISTANT_TEST_INHERIT"',
        cwd: dir,
        env: { DEV_ASSISTANT_EVENT: 'pre-tool', DEV_ASSISTANT_TOOL: 'write_file' },
      })
      expect(r.stdout).toBe('pre-tool|write_file|inherited-ok')
    } finally {
      // 断言失败也不能把环境变量泄漏给同 worker 的其他测试文件
      delete process.env.DEV_ASSISTANT_TEST_INHERIT
    }
  })

  it('cwd 生效（相对路径在 cwd 下可解析）', async () => {
    await writeFile(path.join(dir, 'cwd-probe.txt'), 'x')
    const r = await runShell({ command: 'test -f cwd-probe.txt', cwd: dir })
    expect(r.success).toBe(true)
    const r2 = await runShell({ command: 'test -f cwd-probe.txt', cwd: tmpdir() })
    expect(r2.success).toBe(false)
  })

  it('超时：timedOut=true 且不无限等待', async () => {
    const started = Date.now()
    const r = await runShell({ command: 'sleep 5', cwd: dir, timeoutMs: 150 })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(r.timedOut).toBe(true)
    expect(r.success).toBe(false)
  })

  it('AbortSignal 取消：aborted=true', async () => {
    const ac = new AbortController()
    const p = runShell({ command: 'sleep 5', cwd: dir, signal: ac.signal, timeoutMs: 30_000 })
    setTimeout(() => ac.abort(), 100)
    const r = await p
    expect(r.aborted).toBe(true)
    expect(r.success).toBe(false)
  })

  it('stdout 超 100_000 字节被截断', async () => {
    const r = await runShell({ command: 'yes xxxxx | head -c 150000', cwd: dir, timeoutMs: 10_000 })
    expect(r.success).toBe(true)
    expect(r.stdout).toContain('(输出截断)')
    expect(r.stdout.length).toBeLessThan(110_000)
    expect(r.stdout.length).toBeGreaterThan(90_000)
  })

  it('stderr 超 50_000 字节被截断', async () => {
    const r = await runShell({ command: 'yes yyyyy | head -c 60000 >&2', cwd: dir, timeoutMs: 10_000 })
    expect(r.stderr).toContain('(输出截断)')
    expect(r.stderr.length).toBeLessThan(60_000)
  })

  it('命令不存在：不抛异常，返回失败结果', async () => {
    const r = await runShell({ command: 'this-binary-does-not-exist-xyz', cwd: dir })
    expect(r.success).toBe(false)
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true)
  })
})

describe('HookManager', () => {
  function mgr(hooks: HookDefinition[]): HookManager {
    const m = new HookManager()
    m.setHooks(hooks)
    return m
  }

  it('list 返回副本，外部修改不影响内部状态', () => {
    const m = mgr([{ name: 'a', event: 'agent-done', command: 'echo a' }])
    m.list().push({ name: 'b', event: 'agent-done', command: 'echo b' })
    expect(m.list()).toHaveLength(1)
  })

  it('isEnabled 默认 true，setDisabled 后 false', () => {
    const m = mgr([])
    expect(m.isEnabled()).toBe(true)
    m.setDisabled(true)
    expect(m.isEnabled()).toBe(false)
  })

  it('disabled 时 fire 直接返回空且不执行命令', async () => {
    const marker = path.join(dir, 'should-not-exist')
    const m = mgr([{ name: 'boom', event: 'agent-done', command: `touch ${marker}` }])
    m.setDisabled(true)
    expect(await m.fire('agent-done', { cwd: dir })).toEqual([])
    expect(existsSync(marker)).toBe(false)
  })

  it('无匹配事件时不执行', async () => {
    const m = mgr([{ name: 'x', event: 'session-start', command: 'exit 1' }])
    expect(await m.fire('agent-done', { cwd: dir })).toEqual([])
  })

  it('pre-tool/post-tool 按工具名过滤，无 tool 约束的 hook 恒匹配', async () => {
    const m = mgr([
      { name: 'only-write', event: 'pre-tool', tool: 'write_file', command: 'echo w' },
      { name: 'any-tool', event: 'pre-tool', command: 'echo a' },
    ])
    const forRead = await m.fire('pre-tool', { cwd: dir, tool: 'read_file' })
    expect(forRead.map((r) => r.name)).toEqual(['any-tool'])

    const forWrite = await m.fire('pre-tool', { cwd: dir, tool: 'write_file' })
    expect(forWrite.map((r) => r.name).sort()).toEqual(['any-tool', 'only-write'])
  })

  it('非 tool 类事件不受 tool 字段过滤影响', async () => {
    const m = mgr([{ name: 'done-hook', event: 'agent-done', tool: 'write_file', command: 'echo d' }])
    const results = await m.fire('agent-done', { cwd: dir, tool: 'read_file' })
    expect(results.map((r) => r.name)).toEqual(['done-hook'])
  })

  it('真实执行并把上下文写入环境变量', async () => {
    const m = mgr([
      {
        name: 'env-probe',
        event: 'post-tool',
        command:
          'printf "%s/%s/%s/%s/%s" "$DEV_ASSISTANT_EVENT" "$DEV_ASSISTANT_TOOL" "$DEV_ASSISTANT_ARGS" "$DEV_ASSISTANT_RESULT" "$DEV_ASSISTANT_SESSION"',
      },
    ])
    const [r] = await m.fire('post-tool', {
      cwd: dir,
      tool: 'exec_command',
      args: '{"command":"ls"}',
      result: 'ok',
      sessionId: 'sess-hook',
    })
    expect(r?.success).toBe(true)
    expect(r?.stdout).toBe('post-tool/exec_command/{"command":"ls"}/ok/sess-hook')
    expect(r?.name).toBe('env-probe')
  })

  it('缺省可选字段时对应环境变量不设置', async () => {
    const m = mgr([
      {
        name: 'sparse-env',
        event: 'session-start',
        // 用 ${VAR-unset} 形式读取，避免 POSIX 下 ${VAR?} 直接终止 shell
        command:
          'printf "%s|%s|%s|%s" "${DEV_ASSISTANT_TOOL-unset}" "${DEV_ASSISTANT_ARGS-unset}" "${DEV_ASSISTANT_SESSION-unset}" "$DEV_ASSISTANT_EVENT"',
      },
    ])
    const [r] = await m.fire('session-start', { cwd: dir })
    expect(r?.success).toBe(true)
    expect(r?.stdout).toBe('unset|unset|unset|session-start')
  })

  it('dry-run 只回显命令不执行', async () => {
    const marker = path.join(dir, 'dry-marker')
    const m = mgr([{ name: 'dry', event: 'agent-done', command: `touch ${marker}` }])
    m.setDryRun(true)
    const [r] = await m.fire('agent-done', { cwd: dir })
    expect(r).toMatchObject({ name: 'dry', success: true, stdout: `[dry-run] touch ${marker}`, durationMs: 0, timedOut: false })
    expect(existsSync(marker)).toBe(false)
  })

  it('单个 hook 失败不阻塞同批其他 hook', async () => {
    const m = mgr([
      { name: 'fail', event: 'agent-done', command: 'echo bad 1>&2; exit 7' },
      { name: 'ok', event: 'agent-done', command: 'echo good' },
    ])
    const results = await m.fire('agent-done', { cwd: dir })
    expect(results).toHaveLength(2)
    const byName = Object.fromEntries(results.map((r) => [r.name, r]))
    expect(byName.fail).toMatchObject({ success: false, stderr: 'bad\n' })
    expect(byName.ok).toMatchObject({ success: true, stdout: 'good\n' })
  })

  it('超时 hook 标记 timedOut 且耗时受 timeoutSecs 控制', async () => {
    const m = mgr([{ name: 'slow', event: 'agent-done', command: 'sleep 3', timeoutSecs: 1 }])
    const started = Date.now()
    const [r] = await m.fire('agent-done', { cwd: dir })
    expect(Date.now() - started).toBeLessThan(2_500)
    expect(r?.timedOut).toBe(true)
    expect(r?.success).toBe(false)
  }, 15_000)

  it('collectInjection 仅收集 injectOutput 且成功的非空输出', () => {
    const defs: HookDefinition[] = [
      { name: 'inject', event: 'agent-done', command: 'echo', injectOutput: true },
      { name: 'silent', event: 'agent-done', command: 'echo' },
      { name: 'inject-fail', event: 'agent-done', command: 'echo', injectOutput: true },
      { name: 'inject-empty', event: 'agent-done', command: 'echo', injectOutput: true },
    ]
    const out = HookManager.collectInjection(
      [
        { name: 'inject', success: true, stdout: '  带上下文  ', stderr: '', durationMs: 1, timedOut: false },
        { name: 'silent', success: true, stdout: '不注入', stderr: '', durationMs: 1, timedOut: false },
        { name: 'inject-fail', success: false, stdout: '失败', stderr: 'e', durationMs: 1, timedOut: false },
        { name: 'inject-empty', success: true, stdout: '   ', stderr: '', durationMs: 1, timedOut: false },
      ],
      defs,
    )
    expect(out).toEqual(['[hook:inject] 带上下文'])
  })
})

describe('run_hook 工具', () => {
  function toolCtx(hooks?: HookManager) {
    return { workingDir: dir, cache: new ReadCache(), sessionId: 'sess-run-hook', hooks }
  }

  it('缺少 name 参数 → permanent 失败', async () => {
    const r = await runHookHandler({ arguments: {} }, toolCtx(new HookManager()))
    expect(r).toMatchObject({ success: false, content: '缺少参数 name', errorCategory: 'permanent' })
  })

  it('未注入 hooks / 已禁用 → 明确提示未启用', async () => {
    const noMgr = await runHookHandler({ arguments: { name: 'a' } }, toolCtx(undefined))
    expect(noMgr.content).toContain('hook 系统未启用')

    const disabled = new HookManager()
    disabled.setDisabled(true)
    const off = await runHookHandler({ arguments: { name: 'a' } }, toolCtx(disabled))
    expect(off.content).toContain('hook 系统未启用')
  })

  it('hook 未注册时列出可用 hook', async () => {
    const m = new HookManager()
    m.setHooks([
      { name: 'real', event: 'agent-done', command: 'echo 1' },
      { name: 'other', event: 'agent-done', command: 'echo 2' },
    ])
    const r = await runHookHandler({ arguments: { name: 'ghost' } }, toolCtx(m))
    expect(r.success).toBe(false)
    expect(r.content).toContain('未注册')
    expect(r.content).toContain('real')
    expect(r.content).toContain('other')
  })

  it('空 hook 列表提示（无）', async () => {
    const m = new HookManager()
    m.setHooks([])
    const r = await runHookHandler({ arguments: { name: 'x' } }, toolCtx(m))
    expect(r.content).toContain('可用 hook: （无）')
  })

  it('成功执行：输出包含 hook 名/状态/stdout/耗时', async () => {
    const m = new HookManager()
    m.setHooks([{ name: 'hello', event: 'agent-done', command: 'echo hi-from-hook' }])
    const r = await runHookHandler({ arguments: { name: 'hello' } }, toolCtx(m))
    expect(r.success).toBe(true)
    expect(r.content).toContain('hook: hello')
    expect(r.content).toContain('状态: 成功')
    expect(r.content).toContain('hi-from-hook')
    expect(r.content).toMatch(/耗时: \d+ms/)
    expect(r.errorCategory).toBeUndefined()
  })

  it('失败执行：附带 stderr 段 + permanent 分类', async () => {
    const m = new HookManager()
    m.setHooks([{ name: 'broken', event: 'agent-done', command: 'echo nope 1>&2; exit 2' }])
    const r = await runHookHandler({ arguments: { name: 'broken' } }, toolCtx(m))
    expect(r.success).toBe(false)
    expect(r.content).toContain('状态: 失败')
    expect(r.content).toContain('--- stderr ---')
    expect(r.content).toContain('nope')
    expect(r.errorCategory).toBe('permanent')
  })

  it('fire 结果为空（被过滤）时提示无结果', async () => {
    // Agent 侧可能对 hook 做二次过滤，这里用桩 manager 覆盖该分支
    const stub = {
      isEnabled: () => true,
      list: () => [{ name: 'ghost-fire', event: 'agent-done', command: 'echo x' }],
      fire: async () => [],
    } as unknown as HookManager
    const r = await runHookHandler({ arguments: { name: 'ghost-fire' } }, toolCtx(stub))
    expect(r.success).toBe(false)
    expect(r.content).toContain('执行无结果')
  })
})
