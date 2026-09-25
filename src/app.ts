import path from 'node:path'
import { LlmClient } from './llm/client.js'
import type { ProviderConfig } from './llm/models.js'
import { ToolRegistry } from './tools/registry.js'
import { ReadCache } from './tools/cache.js'
import { ApprovalManager, type ConfirmHandler } from './security/approval.js'
import { SessionStore } from './persist/session-store.js'
import { HookManager } from './hooks/manager.js'
import { Agent, type AgentEvent, type AgentResult } from './agent/agent.js'
import { Memory } from './agent/memory.js'
import { buildSystemPrompt, type PromptContext } from './prompt.js'
import { loadHooksConfig } from './hooks/config.js'
import { loadSkills, skillsToPromptSection, skillsToSummary } from './skills/index.js'
import { SchedulerEngine } from './scheduler/engine.js'
import type { ScheduledTask } from './scheduler/types.js'
import { log } from './utils/logger.js'
import { AppError } from './utils/error.js'
import { readFileSpec, readFileHandler } from './tools/file/read.js'
import { batchReadFilesSpec, batchReadFilesHandler } from './tools/file/batch-read.js'
import { writeFileSpec, writeFileHandler } from './tools/file/write.js'
import { editFileSpec, editFileHandler } from './tools/file/edit.js'
import { readSymbolSpec, readSymbolHandler } from './tools/file/read-symbol.js'
import { globSpec, globHandler } from './tools/file/glob.js'
import { listDirectorySpec, listDirectoryHandler } from './tools/file/list-directory.js'
import { fileExistsSpec, fileExistsHandler } from './tools/file/file-exists.js'
import { execCommandSpec, execCommandHandler } from './tools/system/exec-command.js'
import { finishSpec, finishHandler } from './tools/meta/finish.js'
import { restartSpec, restartHandler } from './tools/meta/restart.js'
import { runHookSpec, runHookHandler } from './tools/meta/run-hook.js'
import { spawnSubagentSpec, spawnSubagentHandler } from './tools/subagent/spawn-subagent.js'
import { kbStoreSpec, kbStoreHandler } from './tools/kb/kb-store-tool.js'
import { kbQuerySpec, kbQueryHandler } from './tools/kb/kb-query.js'
import { taskStatusSpec, taskStatusHandler } from './tools/task/task-status.js'
import { pauseTaskSpec, pauseTaskHandler } from './tools/task/pause-task.js'
import { resumeTaskSpec, resumeTaskHandler } from './tools/task/resume-task.js'
import { cancelTaskSpec, cancelTaskHandler } from './tools/task/cancel-task.js'
import { analyzeCodebaseSpec, analyzeCodebaseHandler } from './tools/analysis/analyze-codebase.js'
import { recordAnalysisSpec, recordAnalysisHandler } from './tools/analysis/record-analysis.js'
import { getAnalysisSummarySpec, getAnalysisSummaryHandler } from './tools/analysis/get-analysis-summary.js'
import { finishAnalysisSpec, finishAnalysisHandler } from './tools/analysis/finish-analysis.js'
import { scheduleTaskSpec, scheduleTaskHandler } from './tools/scheduler/schedule-task.js'
import { unscheduleTaskSpec, unscheduleTaskHandler } from './tools/scheduler/unschedule-task.js'
import { listScheduledTasksSpec, listScheduledTasksHandler } from './tools/scheduler/list-scheduled-tasks.js'
import { getScheduledTaskLogsSpec, getScheduledTaskLogsHandler } from './tools/scheduler/get-scheduled-task-logs.js'
import { contextBudgetSpec, contextBudgetHandler } from './tools/context-budget/context-budget.js'
import { compressContextToolSpec, compressContextToolHandler } from './tools/context-budget/compress-context.js'
import { saveSummarySpec, saveSummaryHandler } from './tools/context-budget/save-summary.js'

/**
 * App：组装所有子系统（对齐 Rust 版 `src/app.rs`）。
 *
 * 组合关系：
 *   App
 *   ├─ LlmClient（多 provider 故障转移）
 *   ├─ ToolRegistry（12 个工具：8 文件 + exec + 3 meta）
 *   ├─ ApprovalManager（审批，confirm 回调注入 UI）
 *   ├─ SessionStore（JSONL 持久化，单会话多轮）
 *   ├─ HookManager（hooks）
 *   └─ Agent（会话级持久主循环；REPL 跨消息保留上下文）
 */

export interface AppOptions {
  workingDir: string
  models: ProviderConfig[]
  maxIterations?: number
  maxTokens?: number
  approvalEnabled?: boolean
  hooksEnabled?: boolean
  hooksDryRun?: boolean
  hooksConfigPath?: string
  /** 恢复会话文件路径（--resume） */
  resumeFile?: string
  /** 审批确认回调（CLI 注入终端 prompt） */
  confirmApproval?: ConfirmHandler
  /** 禁用长期记忆（默认启用） */
  memoryEnabled?: boolean
  /** 禁用技能加载（默认启用） */
  skillsEnabled?: boolean
  /** 技能摘要注入（loadSkills 结果；缺省时由 App 自动加载） */
  skills?: Array<{ name: string; description: string }>
  /**
   * 启用调度引擎 tick（CLI --scheduler / Web 层为 true）。
   * 未启用时调度工具仍可创建任务（持久化），但不到点执行；进程重启后启用即恢复触发。
   */
  schedulerEnabled?: boolean
  /** 调度任务执行器（Web 层注入 WS 广播执行；缺省为静默执行日志） */
  schedulerExecutor?: (task: ScheduledTask) => Promise<string>
  /**
   * 按名称禁用工具（不注册进注册表，LLM 不可见）。
   * 嵌入宿主（如 devworkbench）用此裁剪危险工具（exec_command / run_hook），
   * 使 approvalEnabled:false 的自动审批模式不再暴露任意命令执行面。
   */
  disabledTools?: string[]
}

export class App {
  readonly workingDir: string
  readonly llm: LlmClient
  readonly tools: ToolRegistry
  readonly approval: ApprovalManager
  readonly hooks: HookManager
  readonly sessionStore: SessionStore
  readonly agent: Agent
  readonly memory: Memory
  /** 调度引擎（--scheduler 启用时启动 tick；scheduler 工具族经 ToolContext.scheduler 访问） */
  readonly scheduler: SchedulerEngine
  private readonly cache = new ReadCache()
  /** 调度任务执行锁（防止与用户交互的 Agent 运行并发） */
  private agentBusy = false

  private constructor(
    opts: AppOptions,
    llm: LlmClient,
    tools: ToolRegistry,
    sessionStore: SessionStore,
    hooks: HookManager,
    systemPrompt: string,
    memory: Memory,
    scheduler: SchedulerEngine,
  ) {
    this.workingDir = opts.workingDir
    this.llm = llm
    this.tools = tools
    this.approval = new ApprovalManager(opts.confirmApproval ?? (async () => false))
    this.approval.setDisabled(!(opts.approvalEnabled ?? true))
    this.hooks = hooks
    this.hooks.setDisabled(!(opts.hooksEnabled ?? true))
    this.hooks.setDryRun(Boolean(opts.hooksDryRun))
    this.sessionStore = sessionStore
    this.memory = memory
    this.scheduler = scheduler

    this.agent = new Agent({
      llm,
      tools,
      sessionStore,
      approval: this.approval,
      hooks,
      workingDir: opts.workingDir,
      maxIterations: opts.maxIterations ?? 10,
      maxTokens: opts.maxTokens ?? 262_144,
      systemPrompt,
      memory,
      scheduler,
    })
    this.agent.setCache(this.cache)
  }

  /** 构建 App（加载 hooks 配置、组装工具） */
  static async create(opts: AppOptions): Promise<App> {
    const workingDir = path.resolve(opts.workingDir)

    if (!opts.models || opts.models.length === 0) {
      throw AppError.Config('未配置任何 LLM provider（需 .dev-assistant-models.toml 或 --provider/--model）')
    }
    const llm = new LlmClient(opts.models)

    // 工具注册（Phase 2 全集；嵌入宿主可经 disabledTools 裁剪危险工具，如 exec_command）
    const tools = buildTools(opts.disabledTools)

    // hooks
    const hooks = new HookManager()
    const hookDefs = opts.hooksEnabled === false ? [] : await loadHooksConfig(workingDir, opts.hooksConfigPath)
    hooks.setHooks(hookDefs)
    log.debug('hooks 加载', { count: hookDefs.length, disabled: hooks.isEnabled() ? 'no' : 'yes' })

    // 会话持久化
    const sessionStore = new SessionStore(workingDir, undefined, opts.resumeFile)
    log.info('会话', { sessionId: sessionStore.sessionId, file: sessionStore.getFilePath() })

    // 长期记忆（注入系统提示词）
    const memory = new Memory(workingDir)
    if (opts.memoryEnabled !== false) {
      await memory.load()
      log.debug('记忆加载', { count: memory.size, file: memory.filePath })
    }

    // 已安装技能（注入系统提示词）
    const skills = opts.skillsEnabled === false ? [] : await loadSkills(workingDir)

    // 调度引擎（tick 仅在 schedulerEnabled 时启动；工具始终可用）
    const scheduler = new SchedulerEngine(workingDir, {
      executor:
        opts.schedulerExecutor ??
        (async (task) => {
          log.info('调度任务执行（静默模式）', { id: task.id, name: task.name })
          return `静默模式：未配置执行器，任务 ${task.name} 仅记录触发`
        }),
    })
    if (opts.schedulerEnabled !== false) {
      await scheduler.start()
    }

    // 系统提示词
    const promptCtx: PromptContext = {
      workingDir,
      platform: process.platform,
      sessionId: sessionStore.sessionId,
      approvalEnabled: opts.approvalEnabled ?? true,
      skills: opts.skills ?? skillsToSummary(skills),
      memory: memory.size > 0 ? memory.all().map((e) => e.content) : undefined,
      extraInstructions: skillsToPromptSection(skills) ? [skillsToPromptSection(skills)!] : undefined,
    }
    const systemPrompt = buildSystemPrompt(promptCtx)

    return new App(opts, llm, tools, sessionStore, hooks, systemPrompt, memory, scheduler)
  }

  /** 设置流式事件回调（CLI/UI 注入） */
  setOnEvent(cb: (event: AgentEvent) => void): void {
    this.agent.setOnEvent(cb)
  }

  /** 运行一次任务（会话级 Agent，多轮保留上下文） */
  async run(message: string): Promise<AgentResult> {
    if (this.agentBusy) {
      throw AppError.Internal('Agent 正在执行调度任务，请稍后再试')
    }
    this.agentBusy = true
    try {
      return await this.agent.run(message)
    } finally {
      this.agentBusy = false
    }
  }

  /** 清理（flush 持久化、关闭连接池、停止调度器） */
  async close(): Promise<void> {
    this.scheduler.stop()
    this.sessionStore.close()
    await this.llm.close()
  }

  /** 运行时热替换模型配置（嵌入场景：设置页保存后无需重启进程） */
  async replaceLlm(models: ProviderConfig[]): Promise<void> {
    const next = new LlmClient(models)
    this.agent.setLlm(next)
    await this.llm.close()
    ;(this as { llm: LlmClient }).llm = next
  }

  get sessionId(): string {
    return this.sessionStore.sessionId
  }
}

/** 组装工具注册表（26 个；调度工具 4 个在 Phase 5 随 scheduler 子系统补全，文档第 6 章小节之和为 30） */
export function buildTools(disabled?: string[]): ToolRegistry {
  const registry = new ToolRegistry()

  // 文件工具（8）
  registry.register(readFileSpec, readFileHandler)
  registry.register(batchReadFilesSpec, batchReadFilesHandler)
  registry.register(writeFileSpec, writeFileHandler)
  registry.register(editFileSpec, editFileHandler)
  registry.register(readSymbolSpec, readSymbolHandler)
  registry.register(globSpec, globHandler)
  registry.register(listDirectorySpec, listDirectoryHandler)
  registry.register(fileExistsSpec, fileExistsHandler)

  // 系统工具（1）
  registry.register(execCommandSpec, execCommandHandler)

  // 子代理工具（1）
  registry.register(spawnSubagentSpec, spawnSubagentHandler)

  // 知识库工具（2）
  registry.register(kbStoreSpec, kbStoreHandler)
  registry.register(kbQuerySpec, kbQueryHandler)

  // 任务工具（4）
  registry.register(taskStatusSpec, taskStatusHandler)
  registry.register(pauseTaskSpec, pauseTaskHandler)
  registry.register(resumeTaskSpec, resumeTaskHandler)
  registry.register(cancelTaskSpec, cancelTaskHandler)

  // 分析工具（4）
  registry.register(analyzeCodebaseSpec, analyzeCodebaseHandler)
  registry.register(recordAnalysisSpec, recordAnalysisHandler)
  registry.register(getAnalysisSummarySpec, getAnalysisSummaryHandler)
  registry.register(finishAnalysisSpec, finishAnalysisHandler)

  // 调度工具（4）
  registry.register(scheduleTaskSpec, scheduleTaskHandler)
  registry.register(unscheduleTaskSpec, unscheduleTaskHandler)
  registry.register(listScheduledTasksSpec, listScheduledTasksHandler)
  registry.register(getScheduledTaskLogsSpec, getScheduledTaskLogsHandler)

  // 上下文工具（3）
  registry.register(contextBudgetSpec, contextBudgetHandler)
  registry.register(compressContextToolSpec, compressContextToolHandler)
  registry.register(saveSummarySpec, saveSummaryHandler)

  // 元工具（3）
  registry.register(finishSpec, finishHandler)
  registry.register(restartSpec, restartHandler)
  registry.register(runHookSpec, runHookHandler)

  return disabled && disabled.length > 0 ? filterOutTools(registry, disabled) : registry
}

/** 按名称裁剪工具（返回新注册表，不修改原表）。嵌入宿主禁用危险工具用。 */
function filterOutTools(registry: ToolRegistry, disabled: string[]): ToolRegistry {
  const child = new ToolRegistry()
  for (const name of registry.listNames()) {
    if (disabled.includes(name)) continue
    const t = registry.get(name)
    if (t) child.register(t.spec, t.handler)
  }
  return child
}

/**
 * 子代理工具集：移除 spawn_subagent（防止无限递归），其余工具继承。
 * 返回新 ToolRegistry（不修改父注册表）。
 */
export function subagentTools(parent: ToolRegistry): ToolRegistry {
  const child = new ToolRegistry()
  for (const name of parent.listNames()) {
    if (name === 'spawn_subagent') continue
    const t = parent.get(name)
    if (t) child.register(t.spec, t.handler)
  }
  return child
}
