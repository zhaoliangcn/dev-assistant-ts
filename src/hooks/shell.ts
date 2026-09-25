import { spawn } from 'node:child_process'

/**
 * Shell 执行（hook 命令运行器）。
 * 用 sh -c 执行，支持超时、stdout/stderr 捕获、取消。
 */

export interface ShellRunOptions {
  command: string
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ShellRunResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

export function runShell(opts: ShellRunOptions): Promise<ShellRunResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', opts.command], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // 再给 5s 优雅退出，否则强杀
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.()
    }, opts.timeoutMs ?? 30_000)
    timer.unref?.()

    const onAbort = () => {
      aborted = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8')
      if (stdout.length > 100_000) {
        // 防止 hook 输出无限增长
        stdout = `${stdout.slice(0, 100_000)}\n…(输出截断)`
      }
    })
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
      if (stderr.length > 50_000) {
        stderr = `${stderr.slice(0, 50_000)}\n…(输出截断)`
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({
        success: false,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        exitCode: null,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
      })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({
        success: code === 0 && !timedOut && !aborted,
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
      })
    })
  })
}
