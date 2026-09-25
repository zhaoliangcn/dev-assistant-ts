#!/usr/bin/env node
/**
 * CLI 入口（commander 解析）。
 * - --message <msg>：一次性执行（经 App/Agent 完整循环，支持工具调用）
 * - 无 --message：进入交互 REPL（repl.ts）
 * Phase 3 起 CLI 渲染迁移到 ink；当前为纯文本流式输出。
 */
import { Command } from 'commander'
import path from 'node:path'
import chalk from 'chalk'
import { configureLogger, log } from './utils/logger.js'
import { AppError, isAppError } from './utils/error.js'
import { loadModelsConfig, applyOverrides } from './config/index.js'
import { App } from './app.js'
import { runRepl } from './repl.js'
import { SessionStore } from './persist/session-store.js'
import type { AgentEvent } from './agent/agent.js'
import type { ConfirmHandler } from './security/approval.js'
import { promptConfirm } from './utils/prompt.js'

export interface CliOptions {
  message?: string
  project: string
  config?: string
  provider?: string
  model?: string
  approval: boolean
  hooks: boolean
  hooksDryRun: boolean
  verbose: boolean
  maxIterations: string
  maxTokens: string
  resume: boolean
  background: boolean
  web: boolean
  port: string
  host: string
  scheduler: boolean
}

const program = new Command()

program
  .name('dev-assistant')
  .description('AI 编程代理（dev-assistant-ts，TypeScript 实现）')
  .version('0.1.0')
  .option('--message <msg>', '一次性执行消息')
  .option('--project <dir>', '项目目录', '.')
  .option('--config <path>', '模型配置文件（.dev-assistant-models.toml 路径）')
  .option('--provider <name>', '覆盖 provider（按名称匹配配置条目）')
  .option('--model <name>', '覆盖模型名')
  .option('--no-approval', '关闭审批')
  .option('--no-hooks', '禁用 hook')
  .option('--hooks-dry-run', '预览 hook 不执行')
  .option('--verbose', '详细日志')
  .option('--max-iterations <n>', '最大迭代次数', '10')
  .option('--max-tokens <n>', '上下文窗口 token 数', '262144')
  .option('--resume', '恢复最近会话')
  .option('--background', '后台模式')
  .option('--web', '启动 Web 服务')
  .option('--port <port>', 'Web 端口', '8080')
  .option('--host <host>', 'Web 主机', '127.0.0.1')
  .option('--no-scheduler', '禁用调度引擎（调度工具仍可用，任务只持久化不触发）')

// 调度任务子命令（Phase 5：scheduler add|list|runs|cancel）
const schedulerCmd = program.command('scheduler').description('定时任务管理（创建/列表/运行记录/取消）')

schedulerCmd
  .command('add <name>')
  .description('创建定时任务')
  .requiredOption('--prompt <text>', '任务提示词')
  .option('--every <seconds>', 'interval：周期（秒）')
  .option('--once-in <seconds>', 'once：N 秒后执行一次')
  .action(async (name: string, opts: { prompt: string; every?: string; onceIn?: string }) => {
    const wd = path.resolve(optsOf(program).project)
    const { SchedulerEngine } = await import('./scheduler/engine.js')
    const engine = new SchedulerEngine(wd, { executor: async () => 'cli-managed' })
    try {
      const secs = opts.every ? parsePositiveInt(opts.every, '--every') : parsePositiveInt(opts.onceIn!, '--once-in')
      const schedule: import('./scheduler/types.js').TaskSchedule = opts.every
        ? { type: 'interval', everyMs: secs * 1000, nextAt: new Date(Date.now() + secs * 1000).toISOString() }
        : { type: 'once', at: new Date(Date.now() + secs * 1000).toISOString() }
      const task = await engine.createTask(name, opts.prompt, schedule)
      console.log(chalk.green(`已创建任务: ${task.name} (${task.schedule.type})`))
      console.log(chalk.dim(`id: ${task.id}`))
    } finally {
      engine.stop()
    }
  })

schedulerCmd
  .command('list')
  .description('列出定时任务')
  .option('--state <state>', '按状态过滤 (active|done|canceled)')
  .action(async (opts: { state?: string }) => {
    const wd = path.resolve(optsOf(program).project)
    const { ScheduledTaskStore } = await import('./scheduler/store.js')
    const store = new ScheduledTaskStore(wd)
    const tasks = await store.list(opts.state ? { status: opts.state as 'active' } : undefined)
    if (tasks.length === 0) {
      console.log('（无定时任务）')
      return
    }
    for (const t of tasks) {
      const sched =
        t.schedule.type === 'once'
          ? `once @ ${t.schedule.at}`
          : `every ${Math.round(t.schedule.everyMs / 1000)}s`
      console.log(`${chalk.cyan(t.status)} ${chalk.yellow(t.name)}  ${chalk.dim(sched)}  runs=${t.runCount} last=${t.lastStatus ?? '-'}`)
      console.log(chalk.dim(`    id: ${t.id}`))
    }
  })

schedulerCmd
  .command('runs <id>')
  .description('查看任务运行记录')
  .action(async (id: string) => {
    const wd = path.resolve(optsOf(program).project)
    const { ScheduledTaskStore } = await import('./scheduler/store.js')
    const store = new ScheduledTaskStore(wd)
    const logs = await store.logsFor(id)
    if (logs.length === 0) {
      console.log('（无运行记录）')
      return
    }
    for (const l of logs) {
      const mark = l.status === 'ok' ? chalk.green('✓') : chalk.red('✗')
      console.log(`${mark} ${chalk.dim(l.at)}  ${l.detail}`)
    }
  })

schedulerCmd
  .command('cancel <id>')
  .description('取消任务')
  .action(async (id: string) => {
    const wd = path.resolve(optsOf(program).project)
    const { SchedulerEngine } = await import('./scheduler/engine.js')
    const engine = new SchedulerEngine(wd, { executor: async () => 'cli-managed' })
    const task = await engine.cancelTask(id)
    engine.stop()
    if (!task) {
      console.error(chalk.red(`任务不存在: ${id}`))
      process.exitCode = 1
      return
    }
    console.log(chalk.green(`已取消: ${task.name}`))
  })

// 技能管理子命令（Phase 5：skill add|list|remove|update）
const skillCmd = program.command('skill').description('技能管理（安装/列表/卸载/更新）')

skillCmd
  .command('add <url>')
  .description('从 Git 仓库安装技能')
  .option('--branch <branch>', 'Git 分支')
  .action(async (url: string, cmdOpts: { branch?: string }) => {
    const { installSkillFromGit } = await import('./skills/installer.js')
    const skill = await installSkillFromGit(path.resolve(optsOf(program).project), url, cmdOpts.branch)
    console.log(chalk.green(`已安装技能: ${skill.name}`))
    console.log(chalk.dim(skill.description))
  })

skillCmd
  .command('list')
  .description('列出已安装技能')
  .action(async () => {
    const { loadSkills } = await import('./skills/index.js')
    const skills = await loadSkills(path.resolve(optsOf(program).project))
    if (skills.length === 0) {
      console.log('（无已安装技能；skill add <git-url> 安装）')
      return
    }
    for (const s of skills) {
      console.log(`${chalk.cyan(s.name)}  ${chalk.dim(s.description)}`)
    }
  })

skillCmd
  .command('remove <name>')
  .description('卸载技能')
  .action(async (name: string) => {
    const { rm } = await import('node:fs/promises')
    const dir = path.join(path.resolve(optsOf(program).project), '.dev-assistant-skills', name)
    await rm(dir, { recursive: true, force: true })
    console.log(chalk.green(`已卸载技能: ${name}`))
  })

skillCmd
  .command('update <name>')
  .description('更新技能（重新安装）')
  .option('--branch <branch>', 'Git 分支')
  .action(async (name: string) => {
    // update = remove + add（需重新提供 URL 时由用户执行 skill add）
    const { rm } = await import('node:fs/promises')
    const dir = path.join(path.resolve(optsOf(program).project), '.dev-assistant-skills', name)
    await rm(dir, { recursive: true, force: true })
    console.log(chalk.yellow(`已移除 ${name}；运行 skill add <url> 重新安装`))
  })

/** 读取主命令选项（供 skill 子命令获取 --project） */
function optsOf(prog: Command): CliOptions {
  return prog.opts<CliOptions>()
}

function parsePositiveInt(value: string, name: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    throw AppError.Config(`${name} 必须是正整数，实际: ${value}`)
  }
  return Math.floor(n)
}

/** 纯文本流式事件渲染（Phase 3 迁移 ink） */
function renderEvent(event: AgentEvent): void {
  switch (event.kind) {
    case 'assistantStreamDelta':
      process.stdout.write(event.content)
      break
    case 'reasoningDelta':
      process.stdout.write(chalk.dim(event.content))
      break
    case 'toolCall': {
      const args = previewArgs(event.call.function.arguments)
      const level = event.security?.dangerLevel ?? 'low'
      const levelColor =
        level === 'critical' ? chalk.red : level === 'high' ? chalk.yellow : level === 'medium' ? chalk.cyan : chalk.gray
      process.stdout.write(
        `\n${chalk.magenta('🔧 ')}${event.call.function.name} ${chalk.dim(args)} ${levelColor(`[${level}]`)}\n`,
      )
      break
    }
    case 'toolResult': {
      const mark = event.result.success ? chalk.green('✓') : chalk.red('✗')
      const preview = event.result.content.replace(/\n/g, ' ').slice(0, 300)
      process.stdout.write(`${mark} ${chalk.dim(preview)}\n`)
      break
    }
    case 'status':
      process.stdout.write(chalk.dim(`\n⏳ ${event.content}\n`))
      break
    case 'systemMessage':
      process.stdout.write(chalk.dim(`[hook] ${event.content}\n`))
      break
    case 'tokenUsage':
      log.debug('token 用量', {
        prompt: event.usage.promptTokens,
        completion: event.usage.completionTokens,
        total: event.usage.totalTokens,
      })
      break
  }
}

function previewArgs(argsJson: string): string {
  const s = argsJson.length > 120 ? `${argsJson.slice(0, 120)}…` : argsJson
  return s
}

/** 构建审批确认回调（终端 prompt） */
function makeConfirmHandler(): ConfirmHandler {
  return async (requirement, scope) => {
    const lines = [
      chalk.yellow('⚠️  需要审批'),
      `   危险级别: ${requirement.dangerThreshold}`,
      `   审批类型: ${requirement.approvalType}${requirement.approvalType === 'session' ? `（有效期 ${requirement.validitySeconds}s）` : ''}`,
      `   作用域:   ${scope}`,
    ]
    // requirement 上不直接带工具名，scope 已含关键信息
    process.stdout.write(lines.join('\n'))
    return promptConfirm('允许执行？(y/N) ')
  }
}

async function main(): Promise<void> {
  const opts = program.opts<CliOptions>()

  configureLogger(Boolean(opts.verbose))
  log.debug('CLI 选项', opts)

  const workingDir = path.resolve(opts.project)
  const maxIterations = parsePositiveInt(opts.maxIterations, '--max-iterations')
  const maxTokens = parsePositiveInt(opts.maxTokens, '--max-tokens')

  if (opts.background) {
    log.warn('--background 将在后续版本实现，当前版本忽略该选项')
  }

  const config = await loadModelsConfig(workingDir, opts.config ?? null)
  const finalConfig = applyOverrides(config, { provider: opts.provider, model: opts.model })

  // --resume：找最近会话文件
  let resumeFile: string | undefined
  if (opts.resume) {
    const sessions = SessionStore.listSessions(workingDir)
    resumeFile = sessions[0]?.file
    if (!resumeFile) {
      log.warn('--resume：未找到可恢复的会话，将新建会话')
    } else {
      log.info('恢复会话', { file: resumeFile })
    }
  }

  const app = await App.create({
    workingDir,
    models: finalConfig.models,
    maxIterations,
    maxTokens,
    approvalEnabled: opts.approval,
    hooksEnabled: opts.hooks,
    hooksDryRun: opts.hooksDryRun,
    resumeFile,
    confirmApproval: makeConfirmHandler(),
    schedulerEnabled: opts.scheduler,
  })
  app.setOnEvent(renderEvent)

  let webHandle: { close(): Promise<void> } | undefined
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await webHandle?.close()
    await app.close()
  }
  process.on('SIGINT', () => {
    void shutdown().then(() => process.exit(130))
  })
  process.on('SIGTERM', () => {
    void shutdown().then(() => process.exit(143))
  })

  try {
    if (opts.web) {
      // Web 模式：Express + /ws/chat，阻塞直到 SIGINT/SIGTERM
      const { startWeb } = await import('./web/server.js')
      webHandle = await startWeb({ app, host: opts.host, port: parsePositiveInt(opts.port, '--port') })
      await new Promise<void>(() => undefined)
    } else if (opts.message !== undefined) {
      app.setOnEvent(renderEvent)
      const result = await app.run(opts.message)
      process.stdout.write('\n')
      if (!result.success) {
        console.error(chalk.red(`任务未完成: ${result.message}`))
        process.exitCode = 1
      }
      log.debug('结果', {
        success: result.success,
        finished: result.finished,
        iterations: result.iterations,
        usage: result.usage,
      })
    } else if (process.stdin.isTTY === true) {
      // TTY 交互模式：ink 组件化 REPL（审批在 UI 内交互）
      const { render } = await import('ink')
      const React = (await import('react')).default
      const { InkRepl } = await import('./ui/repl.js')
      const { ApprovalBridge } = await import('./ui/bridge.js')
      const bridge = new ApprovalBridge()
      app.approval.setConfirm(bridge.requestApproval)

      let exitResolve: () => void = () => undefined
      const exited = new Promise<void>((resolve) => {
        exitResolve = resolve
      })
      const { unmount } = render(
        React.createElement(InkRepl, { app, approvalBridge: bridge, onExit: () => exitResolve() }),
      )
      await exited
      unmount()
    } else {
      // 非 TTY：纯文本 REPL（降级）
      await runRepl(app)
    }
  } finally {
    await shutdown()
  }
}

// 主命令注册 action：commander 中，拥有子命令（skill）却无 action 的主命令
// 在收到纯选项调用（--message/--web）时会按"缺少子命令"处理 → 打印 help 并退出
program.action(async () => {
  try {
    await main()
  } catch (e) {
    if (isAppError(e)) {
      console.error(`错误: ${e.message}`)
      process.exitCode = 1
    } else {
      console.error(`未预期错误: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
      process.exitCode = 1
    }
  }
})

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})
