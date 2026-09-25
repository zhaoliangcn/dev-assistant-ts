/**
 * 系统提示词模板（Phase 3 扩展 skills / memory / 当前文件上下文注入）。
 * 对齐 dev-assistant-rs `src/prompt.rs` 的核心结构。
 */

export interface PromptContext {
  workingDir: string
  /** 平台信息（macos/windows/linux） */
  platform?: string
  /** 会话 id */
  sessionId?: string
  /** 已安装技能摘要（Phase 3） */
  skills?: Array<{ name: string; description: string }>
  /** 长期记忆条目（Phase 3） */
  memory?: string[]
  /** 额外系统指令 */
  extraInstructions?: string[]
  /** 是否启用审批 */
  approvalEnabled?: boolean
}

/** 构建系统提示词 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const platform = ctx.platform ?? process.platform
  const sections: string[] = []

  sections.push(
    `你是一个 AI 编程代理（dev-assistant），运行在 ${platform} 上，工作目录为: ${ctx.workingDir}`,
  )

  sections.push(`当前时间: ${new Date().toISOString()}`)
  if (ctx.sessionId) sections.push(`会话 ID: ${ctx.sessionId}`)

  sections.push(`
## 工具使用规范
- 用 read_file / glob / list_directory 了解代码，用 edit_file 做精确修改，用 write_file 新建或重写文件
- 修改文件前先 read_file 确认内容；edit_file 的 old_string 必须与文件内容精确一致且唯一
- 用 exec_command 运行命令（构建/测试/git），长命令注意 timeout
- 任务完成时必须调用 finish 工具给出最终总结（这是结束任务的唯一结构化方式）
- 不要编造未读过的代码内容；不确定就先读

## 行为准则
- 直接执行，不要只描述打算做什么
- 遇到错误先读报错、诊断根因，再换思路，不要盲目重试同一操作
- 危险操作（删除、force push、系统命令）会被要求审批，被拒绝时换安全方案
- 回复使用与用户相同的语言；代码注释保持原项目风格`)

  if (ctx.approvalEnabled !== false) {
    sections.push(
      '\n## 审批机制\n- 写文件/执行 hook 为 high 级（会话内一次审批后免确认）\n- 执行 shell 命令为 critical 级（每次需确认）\n- 审批被拒绝时，向用户说明原因并等待进一步指示，不要绕过审批',
    )
  }

  if (ctx.skills && ctx.skills.length > 0) {
    const skillLines = ctx.skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
    sections.push(`\n## 可用技能\n${skillLines}`)
  }

  if (ctx.memory && ctx.memory.length > 0) {
    const memLines = ctx.memory.map((m) => `- ${m}`).join('\n')
    sections.push(`\n## 项目记忆\n${memLines}`)
  }

  if (ctx.extraInstructions && ctx.extraInstructions.length > 0) {
    sections.push(`\n## 补充指令\n${ctx.extraInstructions.join('\n')}`)
  }

  return sections.join('\n')
}

/** 压缩后的会话摘要 system 消息前缀 */
export function compressionSummaryPrefix(): string {
  return '以下是本次会话早前内容的压缩摘要（由 Agent 自动生成）：'
}

/** 子代理的附加系统指令（Phase 3 spawn_subagent 用，此处预留） */
export function subagentInstructions(task: string): string {
  return `你是一名子代理，负责完成以下子任务并产出结构化总结（父代理只看到你的总结）：\n任务: ${task}\n\n要求：聚焦任务本身，不扩大范围；总结包含关键结论、涉及文件、未尽事项。`
}

/** 环境信息块（env-info Phase 5 前的简化版） */
export function envInfoBlock(): string {
  return [
    `platform: ${process.platform}`,
    `arch: ${process.arch}`,
    `node: ${process.version}`,
    `cwd: ${process.cwd()}`,
  ].join('\n')
}
