# Dev-Assistant-TS 设计文档

> **项目名称**: dev-assistant-ts
> **定位**: 纯 Node.js/TypeScript 实现的 AI 编程代理框架，功能完整复刻 dev-assistant-rs
> **关系**: dev-assistant-rs 的 Node.js 重写版，独立项目，后续可嵌入 devworkbench
> **语言**: TypeScript 6 + ESM
> **作者**: DevWorkbench Team

---

## 1. 目标

### 1.1 核心目标

- 用 Node.js/TypeScript 1:1 复刻 dev-assistant-rs 的全部功能（27 个工具 + 9 个子系统）
- 保持与 dev-assistant-rs 相同的 CLI 接口、配置格式、持久化格式、API 协议
- 零原生依赖（不需要 Rust 二进制、不需要 code signing），跨 macOS/Windows/Linux
- 可作为独立 CLI + Web 服务运行，也可作为模块嵌入 devworkbench 主进程

### 1.2 与原 Rust 版的兼容性承诺

| 维度 | 兼容策略 |
|---|---|
| CLI 参数 | `--project` `--web` `--port` `--provider` `--model` `--message` `--resume` `--background` `--no-approval` `--no-hooks` `--verbose` `--max-iterations` `--max-tokens` 全部保留 |
| 配置文件 | `.dev-assistant-models.toml` 格式不变，用 `smol-toml` 解析 |
| 会话持久化 | `.dev-assistant-store/session_*.jsonl` 格式不变，事件枚举一致 |
| Web API | `/api/{status,models,sessions,files,skills}` + `/ws/chat` 路由与响应结构一致 |
| 环境变量 | `${VAR}` 占位符解析、`PERSIST_FLUSH_*`、`AGENT_SUMMARY_INTERVAL`、`LLM_CONNECT_TIMEOUT_SECS` 全部保留 |

### 1.3 非目标

- 不实现 GPU 加速推理（仅调用远程/本地 LLM API）
- 不重做 tree-sitter 的完整 ABI 绑定（`read_symbol` 用启发式解析起步，Phase 5 再评估换 `tree-sitter` npm 包）
- 不重写 Web UI 前端（Phase 5 复用 dev-assistant-rs 的 Vue 版静态资源，作为可选项）

---

## 2. 技术栈

| 层 | 选型 | 替代的 Rust 依赖 | 说明 |
|---|---|---|---|
| 语言 | TypeScript 6 + ESM | Rust 2021 | 严格模式，对齐 devworkbench |
| 运行时 | Node.js 20+ | tokio | 原生 async/await + EventLoop |
| CLI 解析 | commander | clap | 子命令支持 |
| HTTP 客户端 | undici | reqwest | Node 内置 fetch 兼容 |
| 流式处理 | 原生 AsyncGenerator + ReadableStream | futures Stream | LLM SSE 流 |
| JSON | 原生 JSON API | serde_json | — |
| TOML | smol-toml | toml | 配置解析 |
| 正则 | 原生 RegExp | regex | — |
| glob 匹配 | picomatch | globset | 工具 glob 实现 |
| 文件遍历 | fast-glob | walkdir/ignore | 尊重 .gitignore |
| 代码高亮 | shiki | syntect | 基于 onig 语法 |
| Markdown | marked | pulldown-cmark | — |
| 目录管理 | node:fs/promises | std::fs | — |
| 终端 UI | ink + ink-spinner | ratatui/rustyline | CLI 渲染 |
| 日志 | pino + pino-pretty | tracing | 结构化日志 |
| WebSocket | ws | axum ws | 服务端 WS |
| HTTP 服务 | express 5 | axum | REST API |
| 静态资源 | serve-static | tower-http ServeDir | Web UI 托管 |
| 加密 | node:crypto | — | 密钥加密存储 |
| 测试 | vitest | cargo test | — |

### 2.1 关键技术决策

**决策 1：HTTP 客户端用 undici 而非 fetch**

`fetch` 的 `AbortController` 取消粒度较粗，且不支持连接池配置。`undici` 提供 `setGlobalDispatcher`、`Agent`、`connectTimeout`、`headersTimeout` 等精细控制，可精确复刻 Rust `reqwest::Client::builder()` 的超时策略。

**决策 2：树解析用启发式起步，tree-sitter 后置**

Rust 版 `read_symbol` 依赖 tree-sitter + tree-sitter-rust。JS 侧有三条路：
- A. `tree-sitter` npm 包（需 node-gyp 编译 C ABI）——最精确但打包麻烦
- B. `ts-morph`（TypeScript 编译器 AST）——只用它做 TS/JS 项目
- C. 正则 + 缩进启发式——最快、零依赖、覆盖度差

**Phase 1–4 用 C 实现 `read_symbol`**，用正则匹配 `function`/`class`/`export`/`const` 等声明模式。Phase 5 评估是否引入 A（tree-sitter）或 B（ts-morph）替换。

**决策 3：调度器用时间轮算法**

Rust 版 `scheduler/wheel.rs` 是经典时间轮。JS 侧用 `SetInterval` 驱动 tick，27 个槽位，每个槽位挂任务链表。不用 `node-cron`（语义不符，cron 表达式 vs 一次性延迟任务）。

**决策 4：流式响应用 AsyncGenerator 而非 EventEmitter**

Rust `Pin<Box<dyn Stream>>` 的 JS 等价物是 `AsyncGenerator<LlmStreamEvent>`。比 EventEmitter 更适合单次消费的流式语义，可直接驱动 React 渲染和 CLI 逐字输出。

**决策 5：持久化用 appendFileSync + 手动 flush**

复刻 Rust 版的批量 flush 策略（`PERSIST_FLUSH_BATCH=10` / `PERSIST_FLUSH_INTERVAL_MS=1000`）。用 `appendFileSync` 而非 `appendFile`，保证每条记录立即可见，避免异步写入的乱序风险。性能足够（JSONL 每行几 KB）。

**决策 6：不实现崩溃恢复的精细检查点**

Rust 版 `orchestrator/checkpoint.rs` 实现了精细的 Agent 状态快照重建。JS 版**简化**为：JSONL 全量持久化 + 摘要落盘（`save_summary` 工具每 5 轮一次）。理由：Electron 嵌入场景下进程崩溃罕见，独立 CLI 场景下 JSONL 已足够恢复对话历史。

---

## 3. 架构总览

```
┌──────────────────────────────────────────────────────────────────────┐
│                        CLI / Web / Module 入口                       │
│   main.ts (CLI)  │  web/server.ts (HTTP+WS)  │  app.ts (Module API) │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
              ┌──────────────▼──────────────┐
              │           App                │
              │  组装 LlmClient / Tools /    │
              │  Agent / SessionStore        │
              └──────┬───────────────┬───────┘
                     │               │
    ┌────────────────▼────┐   ┌──────▼──────────────┐
    │    LlmClient         │   │   Agent             │
    │  多 provider 故障转移 │◄──┤  多轮迭代主循环     │
    │  重试 + 流式 SSE     │   │  子代理管理         │
    │  运行时热切换        │   │  上下文压缩         │
    └──────────┬───────────┘   └──────┬──────────────┘
               │                       │
    ┌──────────▼───────────┐   ┌──────▼──────────────┐
    │  Provider 层         │   │  ToolRegistry        │
    │  openai / openai-    │   │  27 个工具注册       │
    │  compatible / ollama │   │  宽容参数解析        │
    │  / anthropic         │   │  安全评估 + 审批     │
    └──────────────────────┘   └──────┬──────────────┘
                                      │
    ┌─────────────────────────────────▼───────────────┐
    │  支撑子系统                                      │
    │  security/  Session/  persist/  scheduler/       │
    │  memory/    hooks/    skills/   orchestrator/    │
    └──────────────────────────────────────────────────┘
```

### 3.1 数据流

```
用户消息
   │
   ▼
Agent.run(message)
   │
   ├─ 构建 SystemPrompt（含 skills / memory / 当前文件上下文）
   ├─ 调用 LlmClient.call_streaming(messages, tools)
   │      │
   │      └─ Provider.chat_stream()  ← 流式 SSE 事件
   │             │
   │             └─ LlmStreamEvent: Chunk / Reasoning / ToolCallDelta / Usage / Done
   │
   ├─ 若有 ToolCallDelta：
   │      ├─ ToolRegistry.execute_tool(name, args)
   │      │      ├─ SecurityPolicy.evaluate()  ← 危险级别评估
   │      │      ├─ ApprovalManager.check()    ← 审批检查
   │      │      └─ handler(args, context)     ← 实际执行
   │      ├─ 持久化 ToolCallRequest + ToolResult 事件
   │      └─ 把 ToolResult 追加到 messages，回到 LlmClient.call_streaming
   │
   ├─ 若 Chunk（最终文本）：
   │      └─ 累积内容，emit 流式事件给 UI
   │
   ├─ 若 Done：
   │      ├─ 检查是否调用 finish 工具（结构化终止）
   │      ├─ 更新上下文预算（compress_context 若超阈值）
   │      ├─ 每 5 轮触发 save_summary
   │      └─ 持久化 AssistantMessage 事件
   │
   └─ 返回 AgentResult
```

### 3.2 子代理流程

```
父 Agent.run("分析整个代码库的依赖关系")
   │
   └─ LLM 决定调用 spawn_subagent(task="分析 src/llm 模块", depth=1)
          │
          ├─ 构造子 Agent（继承 llm/tools，depth+1）
          ├─ 子 Agent 独立跑完整多轮循环
          ├─ 子 Agent 产出结构化总结
          └─ 总结回传给父 Agent 作为 ToolResult
```

深度限制：`MAX_SUBAGENT_DEPTH=3`，超过返回 `SubagentDepthLimit` 错误。

---

## 4. 目录结构

```
dev-assistant-ts/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── eslint.config.js
├── vitest.config.ts
├── .dev-assistant-models.toml.example
├── README.md
├── docs/
│   └── design.md                          # 本文档
├── src/
│   ├── main.ts                            # CLI 入口（commander 解析）
│   ├── app.ts                             # App 类，组装所有子系统
│   ├── repl.ts                            # 交互循环
│   ├── prompt.ts                          # 系统提示词模板
│   ├── env-info.ts                        # 运行环境信息
│   │
│   ├── llm/
│   │   ├── client.ts                      # LlmClient 多 provider 容器
│   │   ├── models.ts                      # 类型定义
│   │   ├── retry.ts                       # 重试 + 退避策略
│   │   └── provider/
│   │       ├── openai.ts                  # OpenAI + OpenAI 兼容
│   │       ├── ollama.ts                  # Ollama 本地模型
│   │       ├── anthropic.ts               # Anthropic Messages API
│   │       ├── common.ts                  # Provider 接口 + SSE 解析
│   │       └── factory.ts                 # createProvider 工厂
│   │
│   ├── agent/
│   │   ├── agent.ts                       # Agent 主循环 + 子代理
│   │   ├── context.ts                     # ContextManager + token 预算
│   │   ├── compressor.ts                  # 上下文压缩
│   │   ├── summary.ts                     # 分层摘要
│   │   ├── memory.ts                      # 长期记忆注入
│   │   ├── token-counter.ts               # Token 估算
│   │   └── pipeline.ts                    # 流水线阶段（可选）
│   │
│   ├── tools/
│   │   ├── registry.ts                    # ToolRegistry + 定义类型
│   │   ├── common.ts                      # 宽容参数解析
│   │   ├── error.ts                       # 错误类别
│   │   ├── cache.ts                       # ReadCache
│   │   ├── spec.ts                        # 工具安全策略定义
│   │   │
│   │   ├── file/
│   │   │   ├── read.ts                    # read_file
│   │   │   ├── batch-read.ts              # batch_read_files
│   │   │   ├── write.ts                   # write_file
│   │   │   ├── edit.ts                    # edit_file
│   │   │   ├── glob.ts                    # glob
│   │   │   ├── list-directory.ts          # list_directory
│   │   │   ├── file-exists.ts             # file_exists
│   │   │   └── read-symbol.ts             # read_symbol（启发式）
│   │   │
│   │   ├── system/
│   │   │   └── exec-command.ts            # exec_command
│   │   │
│   │   ├── meta/
│   │   │   ├── finish.ts                  # finish
│   │   │   ├── restart.ts                 # restart
│   │   │   └── run-hook.ts                # run_hook
│   │   │
│   │   ├── subagent/
│   │   │   └── spawn-subagent.ts          # spawn_subagent
│   │   │
│   │   ├── kb/
│   │   │   ├── kb-store.ts                # kb_store
│   │   │   └── kb-query.ts                # kb_query
│   │   │
│   │   ├── task/
│   │   │   ├── task-status.ts             # task_status
│   │   │   ├── pause-task.ts              # pause_task
│   │   │   ├── resume-task.ts             # resume_task
│   │   │   └── cancel-task.ts             # cancel_task
│   │   │
│   │   ├── analysis/
│   │   │   ├── analyze-codebase.ts        # analyze_codebase
│   │   │   ├── record-analysis.ts         # record_analysis
│   │   │   ├── get-analysis-summary.ts    # get_analysis_summary
│   │   │   └── finish-analysis.ts         # finish_analysis
│   │   │
│   │   ├── scheduler/
│   │   │   ├── schedule-task.ts           # schedule_task
│   │   │   ├── unschedule-task.ts         # unschedule_task
│   │   │   ├── list-scheduled-tasks.ts    # list_scheduled_tasks
│   │   │   └── get-scheduled-task-logs.ts # get_scheduled_task_logs
│   │   │
│   │   └── context-budget/
│   │       ├── context-budget.ts          # context_budget
│   │       ├── compress-context.ts        # compress_context
│   │       └── save-summary.ts            # save_summary
│   │
│   ├── scheduler/
│   │   ├── engine.ts                      # 调度引擎
│   │   ├── executor.ts                    # 任务执行器
│   │   ├── handler.ts                     # 任务处理
│   │   ├── wheel.ts                       # 时间轮
│   │   ├── store.ts                       # 持久化存储
│   │   └── types.ts                       # 类型定义
│   │
│   ├── security/
│   │   ├── policy.ts                      # SecurityPolicy
│   │   ├── approval.ts                    # ApprovalManager
│   │   └── types.ts                       # DangerLevel / ApprovalType / ApprovalScope
│   │
│   ├── session/
│   │   └── index.ts                       # 会话管理
│   │
│   ├── skills/
│   │   ├── index.ts                       # Skill 加载
│   │   ├── installer.ts                   # Git 克隆安装
│   │   └── meta.ts                        # Skill meta 解析
│   │
│   ├── hooks/
│   │   ├── manager.ts                     # HookManager
│   │   ├── config.ts                      # hook 配置
│   │   ├── shell.ts                       # shell 执行
│   │   └── types.ts                       # hook 类型
│   │
│   ├── dream/                             # 记忆固化（P2）
│   │   ├── ingest.ts
│   │   ├── dedup.ts
│   │   ├── consolidate.ts
│   │   └── forget.ts
│   │
│   ├── persist/
│   │   ├── session-store.ts               # JSONL SessionStore
│   │   └── events.ts                      # SessionEvent 枚举
│   │
│   ├── web/
│   │   ├── server.ts                      # Express 启动
│   │   ├── router.ts                      # 路由组装
│   │   ├── routes/
│   │   │   ├── status.ts                  # /api/status /api/models
│   │   │   ├── sessions.ts                # /api/sessions/*
│   │   │   ├── files.ts                   # /api/files/*
│   │   │   ├── skills.ts                  # /api/skills/*
│   │   │   └── index.ts                   # / /files 页面路由
│   │   ├── ws/
│   │   │   ├── events.ts                  # ClientMessage / ServerEvent
│   │   │   └── chat.ts                    # /ws/chat 处理器
│   │   └── static.ts                      # 静态资源托管
│   │
│   ├── ui/                                # CLI 渲染
│   │   ├── theme.ts                       # 配色方案
│   │   ├── status-bar.ts                  # 状态栏
│   │   ├── markdown.ts                    # Markdown 渲染
│   │   ├── input.ts                       # 输入处理
│   │   └── style.ts                       # 样式工具
│   │
│   └── utils/
│       ├── atomic-write.ts                # 原子文件写入
│       ├── error.ts                       # AppError 类
│       ├── frontmatter.ts                 # YAML frontmatter 解析
│       ├── git.ts                         # Git 操作
│       ├── self-path.ts                   # 自身路径推导
│       └── message-level.ts               # 消息级别
│
├── test/
│   ├── unit/                              # 单元测试
│   ├── integration/                       # 集成测试
│   └── fixtures/                          # 测试夹具
│
├── examples/
│   └── basic.ts                           # 基础使用示例
│
└── scripts/
    └── build.ts                           # 构建脚本
```

---

## 5. 核心类型系统

### 5.1 LLM 类型

```typescript
// src/llm/models.ts

export interface ProviderConfig {
  name: string
  provider: 'openai' | 'openai-compatible' | 'anthropic' | 'ollama'
  apiUrl: string
  apiKey?: string
  model: string
  temperature?: number
  maxOutputTokens?: number
  reasoningEffort?: 'low' | 'medium' | 'high' | 'none' | 'max' | 'xhigh'
}

export interface ModelsConfig {
  models: ProviderConfig[]
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export interface ToolCall {
  id: string
  function: {
    name: string
    arguments: string  // JSON string（OpenAI 协议）
  }
}

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: object  // JSON Schema
  }
}

export interface LlmRequest {
  model: string
  messages: LlmMessage[]
  tools?: ToolSchema[]
  temperature: number
  maxOutputTokens?: number
  reasoningEffort?: string
}

export type LlmResponse =
  | { kind: 'text'; content: string }
  | { kind: 'toolCalls'; calls: ToolCall[] }
  | { kind: 'error'; message: string }

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type LlmStreamEvent =
  | { kind: 'chunk'; content: string }        // 文本增量
  | { kind: 'reasoning'; content: string }    // 思考过程增量
  | { kind: 'toolCallDelta'; call: ToolCall } // 工具调用增量
  | { kind: 'usage'; usage: TokenUsage }      // token 用量
  | { kind: 'done' }                          // 流结束
```

### 5.2 工具类型

```typescript
// src/tools/registry.ts

export type ToolHandler = (
  args: ToolArgs,
  context: ToolContext
) => Promise<ToolResult>

export interface ToolDefinition {
  name: string
  description: string
  parameters: object  // JSON Schema
  skipSecurity?: boolean
  handler: ToolHandler
}

export interface ToolArgs {
  arguments: Record<string, unknown>
}

export interface ToolContext {
  workingDir: string
  selfSourceRoot?: string
  resources?: SharedResources
  cache?: ReadCache
  hooks?: HookManager
}

export type ErrorCategory = 'transient' | 'permanent' | 'llm'

export interface ToolResult {
  success: boolean
  content: string
  securityEvaluation?: SecurityEvaluation
  restartRequested: boolean
  errorCategory?: ErrorCategory
}
```

### 5.3 安全类型

```typescript
// src/security/types.ts

export type DangerLevel = 'low' | 'medium' | 'high' | 'critical'

export type ApprovalType = 'auto' | 'one-time' | 'session'

export type ApprovalScope = 'none' | 'command' | 'path' | 'file'

export interface ApprovalRequirement {
  approvalType: ApprovalType
  dangerThreshold: DangerLevel
  requiresUserConfirmation: boolean
  validitySeconds: number
  scope: ApprovalScope
}

export interface SecurityEvaluation {
  dangerLevel: DangerLevel
  reasons: string[]
  approvalRequirement?: ApprovalRequirement
}
```

### 5.4 持久化事件

```typescript
// src/persist/events.ts

export type SessionEvent =
  | { type: 'user_message'; timestamp: string; sessionId: string; content: string }
  | { type: 'assistant_message'; timestamp: string; sessionId: string; content: string }
  | { type: 'system_message'; timestamp: string; sessionId: string; content: string }
  | { type: 'tool_call_request'; timestamp: string; sessionId: string; toolCallId: string; name: string; arguments: unknown }
  | { type: 'tool_result'; timestamp: string; sessionId: string; toolCallId: string; name: string; success: boolean; content: string }
  | { type: 'context_compression'; timestamp: string; sessionId: string; beforeTokens: number; afterTokens: number }
  | { type: 'summary_saved'; timestamp: string; sessionId: string; level: number; content: string }
```

### 5.5 Web WS 事件

```typescript
// src/web/ws/events.ts

export type ClientMessage =
  | { type: 'user_message'; content: string; id?: string }
  | { type: 'cancel'; messageId?: string }

export type ServerEvent =
  | { type: 'thinking'; content: string; id?: string }
  | { type: 'tool_call'; toolName: string; args: unknown; id?: string }
  | { type: 'tool_result'; toolName: string; success: boolean; content: string; id?: string }
  | { type: 'assistant_message'; content: string; streaming?: boolean; id?: string }
  | { type: 'assistant_stream_delta'; delta: string; isFinal: boolean; id?: string }
  | { type: 'reasoning_delta'; delta: string; isFinal: boolean; id?: string }
  | { type: 'error'; content: string; id?: string }
  | { type: 'done'; messageId?: string }
  | { type: 'status'; content: string; id?: string }
  | { type: 'session_ready'; sessionId: string }
  | { type: 'token_usage'; promptTokens: number; completionTokens: number; totalTokens: number; id?: string }
```

---

## 6. 27 个工具清单

### 6.1 文件工具（8 个）

| 工具 | 文件 | 危险级别 | 说明 |
|---|---|---|---|
| `read_file` | `file/read.ts` | low | 读取文件内容，支持行号范围 |
| `batch_read_files` | `file/batch-read.ts` | low | 批量读取多个文件 |
| `write_file` | `file/write.ts` | high | 写入/覆盖文件，原子写入 |
| `edit_file` | `file/edit.ts` | high | 精确编辑（old_str → new_str 替换） |
| `read_symbol` | `file/read-symbol.ts` | low | 读取符号定义（启发式解析） |
| `glob` | `file/glob.ts` | low | glob 模式匹配文件 |
| `list_directory` | `file/list-directory.ts` | low | 列出目录内容 |
| `file_exists` | `file/file-exists.ts` | low | 检查文件/目录是否存在 |

### 6.2 系统工具（1 个）

| 工具 | 文件 | 危险级别 | 说明 |
|---|---|---|---|
| `exec_command` | `system/exec-command.ts` | critical | 执行 shell 命令，需审批 |

### 6.3 元工具（3 个）

| 工具 | 文件 | 危险级别 | 说明 |
|---|---|---|---|
| `finish` | `meta/finish.ts` | skip | 标记任务完成，结构化终止 |
| `restart` | `meta/restart.ts` | skip | 重启 Agent 会话 |
| `run_hook` | `meta/run-hook.ts` | high | 执行注册的 hook |

### 6.4 子代理工具（1 个）

| 工具 | 文件 | 危险级别 | 说明 |
|---|---|---|---|
| `spawn_subagent` | `subagent/spawn-subagent.ts` | medium | 派生子代理执行子任务 |

### 6.5 知识库工具（2 个）

| 工具 | 文件 | 危险级别 | 说明 |
|---|---|---|---|
| `kb_store` | `kb/kb-store.ts` | low | 存入知识库 |
| `kb_query` | `kb/kb-query.ts` | low | 查询知识库 |

### 6.6 任务工具（4 个）

| 工具 | 文件 | 危险级别 | 说明 |
|---|---|---|---|
| `task_status` | `task/task-status.ts` | low | 查询任务状态 |
| `pause_task` | `task/pause-task.ts` | medium | 暂停任务 |
| `resume_task` | `task/resume-task.ts` | medium | 恢复任务 |
| `cancel_task` | `task/cancel-task.ts` | high | 取消任务 |

### 6.7 分析工具（4 个）

| 工具 | 文件 | 危险级别 | 说明 |
|---|---|---|---|
| `analyze_codebase` | `analysis/analyze-codebase.ts` | low | 开始代码库分析 |
| `record_analysis` | `analysis/record-analysis.ts` | low | 记录分析结果 |
| `get_analysis_summary` | `analysis/get-analysis-summary.ts` | low | 获取分析摘要 |
| `finish_analysis` | `analysis/finish-analysis.ts` | low | 完成分析 |

### 6.8 调度工具（4 个）

| 工具 | 文件 | 危险级别 | 说明 |
|---|---|---|---|
| `schedule_task` | `scheduler/schedule-task.ts` | high | 创建定时/延迟任务 |
| `unschedule_task` | `scheduler/unschedule-task.ts` | medium | 取消调度 |
| `list_scheduled_tasks` | `scheduler/list-scheduled-tasks.ts` | low | 列出调度任务 |
| `get_scheduled_task_logs` | `scheduler/get-scheduled-task-logs.ts` | low | 获取任务日志 |

### 6.9 上下文工具（3 个）

| 工具 | 文件 | 危险级别 | 说明 |
|---|---|---|---|
| `context_budget` | `context-budget/context-budget.ts` | low | 查询上下文预算 |
| `compress_context` | `context-budget/compress-context.ts` | low | 压缩上下文 |
| `save_summary` | `context-budget/save-summary.ts` | low | 保存摘要 |

---

## 7. LLM 客户端设计

### 7.1 重试与退避策略

复刻 Rust 版的三类错误处理：

```typescript
// src/llm/retry.ts

type RetryClass = 'transient' | 'network' | 'fatal'

const MAX_RETRIES = 5
const BASE_DELAY_MS = 2000
const BACKOFF_MULTIPLIER = 2.0
const MAX_DELAY = 120_000

const NETWORK_MAX_RETRIES = 2
const NETWORK_BASE_DELAY_MS = 500
const NETWORK_MAX_DELAY = 5000

function classifyError(error: AppError): RetryClass {
  if (error.isRateLimited() || error.isServerError()) return 'transient'
  if (error.isConnectError()) return 'network'
  return 'fatal'
}

function computeDelay(class: RetryClass, error: AppError, attempt: number): number {
  if (class === 'transient') {
    const retryAfter = error.retryAfter()
    if (retryAfter && retryAfter <= MAX_DELAY) return retryAfter
    const base = BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt - 1)
    const jitterRange = Math.floor(base * 0.25)
    const jitter = Math.floor(Math.random() * (jitterRange + 1))
    return Math.min(base + jitter, MAX_DELAY)
  }
  if (class === 'network') {
    const base = NETWORK_BASE_DELAY_MS * Math.pow(2, attempt - 1)
    return Math.min(base, NETWORK_MAX_DELAY)
  }
  return 0
}
```

### 7.2 多 provider 故障转移

```typescript
// src/llm/client.ts

async call(messages: LlmMessage[], tools: ToolSchema[]): Promise<LlmResponse> {
  if (this.isEmpty()) throw new AppError.Llm(NO_MODEL_HINT)

  const providers = [...this.providers]
  const configs = [...this.providerConfigs]
  const startIdx = this.activeIdx % providers.length
  let lastError: AppError | null = null

  for (let offset = 0; offset < providers.length; offset++) {
    const idx = (startIdx + offset) % providers.length
    const provider = providers[idx]
    const cfg = configs[idx]

    if (offset > 0) {
      log.warn('LLM 故障转移', { from: configs[startIdx].name, to: cfg.name })
      this.activeIdx = idx
    }

    const request: LlmRequest = {
      model: cfg.model,
      messages: [...messages],
      tools: [...tools],
      temperature: roundTemperature(cfg.temperature ?? 0.2),
      maxOutputTokens: cfg.maxOutputTokens,
      reasoningEffort: cfg.reasoningEffort,
    }

    try {
      return await retryWithBackoff(() => provider.chat(this.http, request))
    } catch (e) {
      lastError = e as AppError
      await sleep(1000)  // provider 间短暂延迟
    }
  }

  throw lastError ?? new AppError.Llm('所有 LLM provider 均不可用')
}
```

### 7.3 Provider 接口

```typescript
// src/llm/provider/common.ts

export interface LlmProvider {
  readonly name: string
  readonly type: 'openai' | 'openai-compatible' | 'anthropic' | 'ollama'

  chat(
    http: Client,
    request: LlmRequest
  ): Promise<LlmResponse>

  chatStream(
    http: Client,
    request: LlmRequest
  ): AsyncGenerator<LlmStreamEvent>
}
```

### 7.4 SSE 解析

OpenAI 兼容协议（含 Ollama 的 `/v1/chat/completions`）：
- 请求头 `Accept: text/event-stream`
- 响应行以 `data: ` 前缀，`data: [DONE]` 表示结束
- 累积 `choices[0].delta.content`
- 工具调用从 `choices[0].delta.tool_calls[]` 增量构建

Anthropic 协议：
- 走 `/v1/messages` 端点
- 事件类型：`message_start` / `content_block_start` / `content_block_delta` / `message_stop`
- 工具调用在 `tool_use` content block 中
- 系统提示词放 `system` 字段（不是 messages 数组）

---

## 8. Agent 主循环设计

### 8.1 核心流程

```typescript
// src/agent/agent.ts

export class Agent {
  async run(message: string): Promise<AgentResult> {
    this.sessionStore.append({ type: 'user_message', content: message, ... })
    this.context.appendUser(message)

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      // 1. 检查上下文预算，必要时压缩
      const budget = this.context.budget()
      if (budget.pressure === 'critical') {
        await this.compressContext()
      }

      // 2. 调用 LLM 流式接口
      const stream = await this.llm.callStream(
        this.context.toMessages(),
        this.tools.getToolSchemas()
      )

      // 3. 处理流式事件
      let finalText = ''
      const pendingToolCalls: ToolCall[] = []

      for await (const event of stream) {
        switch (event.kind) {
          case 'chunk':
            finalText += event.content
            this.emit('assistantStreamDelta', event)
            break
          case 'reasoning':
            this.emit('reasoningDelta', event)
            break
          case 'toolCallDelta':
            pendingToolCalls.push(event.call)
            break
          case 'usage':
            this.emit('tokenUsage', event.usage)
            break
          case 'done':
            break
        }
      }

      // 4. 若有工具调用，执行它们
      if (pendingToolCalls.length > 0) {
        this.context.appendAssistant(finalText, pendingToolCalls)

        for (const call of pendingToolCalls) {
          this.sessionStore.append({ type: 'tool_call_request', ... })
          this.emit('toolCall', call)

          const result = await this.tools.execute(call.function.name, call.function.arguments)
          this.sessionStore.append({ type: 'tool_result', ... })
          this.emit('toolResult', result)

          this.context.appendToolResult(call.id, result)

          if (result.restartRequested) {
            return this.handleRestart()
          }
          if (result.securityEvaluation?.approvalRequired) {
            await this.handleApproval(result.securityEvaluation)
          }
        }

        // 继续下一轮迭代
        continue
      }

      // 5. 无工具调用，输出最终回复
      this.context.appendAssistant(finalText)
      this.sessionStore.append({ type: 'assistant_message', content: finalText, ... })

      // 6. 检查是否调用 finish（通过消息前缀识别）
      if (this.isFinishMessage(finalText)) {
        return { success: true, message: finalText, finished: true }
      }

      // 7. 每 N 轮保存摘要
      if (iteration % summaryInterval() === 0 && iteration > 0) {
        await this.saveSummary()
      }

      return { success: true, message: finalText }
    }

    return { success: false, message: '达到最大迭代次数', finished: false }
  }
}
```

### 8.2 上下文预算管理

```typescript
// src/agent/context.ts

export class ContextManager {
  constructor(private maxTokens: number = 262_144) {}

  private messages: LlmMessage[] = []
  private tokenEstimate = 0

  appendUser(content: string): void {
    this.messages.push({ role: 'user', content })
    this.tokenEstimate += estimateTokens(content)
  }

  appendAssistant(content: string, toolCalls?: ToolCall[]): void {
    this.messages.push({ role: 'assistant', content, toolCalls })
    this.tokenEstimate += estimateTokens(content) + (toolCalls?.length ?? 0) * 100
  }

  appendToolResult(callId: string, result: ToolResult): void {
    this.messages.push({
      role: 'tool',
      toolCallId: callId,
      content: result.content,
    })
    this.tokenEstimate += estimateTokens(result.content)
  }

  budget(): ContextBudget {
    const ratio = this.tokenEstimate / this.maxTokens
    const pressure: 'low' | 'medium' | 'high' | 'critical' =
      ratio < 0.5 ? 'low' : ratio < 0.75 ? 'medium' : ratio < 0.9 ? 'high' : 'critical'
    return { current: this.tokenEstimate, max: this.maxTokens, ratio, pressure }
  }

  toMessages(): LlmMessage[] {
    return [...this.messages]
  }
}
```

### 8.3 上下文压缩

```typescript
// src/agent/compressor.ts

export async function compressContext(
  context: ContextManager,
  llm: LlmClient
): Promise<CompressionResult> {
  const messages = context.toMessages()
  const recentCount = Math.max(4, Math.floor(messages.length * 0.2))
  const recent = messages.slice(-recentCount)
  const older = messages.slice(0, -recentCount)

  const summary = await summarizeOlderMessages(older, llm)
  context.reset()
  context.appendSystem(summary)
  recent.forEach(m => /* re-append */)
  return { beforeTokens, afterTokens }
}
```

### 8.4 子代理

```typescript
// src/agent/agent.ts

async spawnSubagent(config: SubagentConfig): Promise<AgentResult> {
  if (config.depth >= MAX_SUBAGENT_DEPTH) {
    throw new AppError.SubagentDepthLimit(config.depth)
  }

  const child = new Agent({
    llm: this.llm,
    tools: this.tools,
    depth: config.depth + 1,
    maxIterations: config.maxIterations,
    maxTokens: config.maxTokens,
  })

  return child.run(config.task)
}
```

---

## 9. 安全与审批设计

### 9.1 危险级别定义

| 级别 | 示例 | 审批策略 |
|---|---|---|
| `low` | 读文件、列目录、glob | 自动通过 |
| `medium` | 任务控制、子代理 | 会话级审批（30 分钟） |
| `high` | 写文件、执行 hook、删除任务 | 会话级审批（1 小时） |
| `critical` | 执行 shell 命令 | 一次性审批（每次确认） |

### 9.2 审批流程

```typescript
// src/security/approval.ts

export class ApprovalManager {
  private approvals: Map<string, ApprovalRecord> = new Map()

  async check(requirement: ApprovalRequirement, scope: string): Promise<boolean> {
    if (requirement.approvalType === 'auto') return true

    const key = `${requirement.scope}:${scope}`
    const existing = this.approvals.get(key)

    if (existing && existing.valid) {
      return true
    }

    // 需要用户确认
    const confirmed = await this.requestConfirmation(requirement, scope)
    if (confirmed) {
      this.approvals.set(key, {
        approvedAt: Date.now(),
        validitySeconds: requirement.validitySeconds,
        type: requirement.approvalType,
      })
      return true
    }
    return false
  }
}
```

---

## 10. 持久化设计

### 10.1 JSONL 存储

```typescript
// src/persist/session-store.ts

export class SessionStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private filePath: string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 17)
    return join(this.dir, `session_${ts}.jsonl`)
  }

  private buffer: SessionEvent[] = []

  append(event: SessionEvent): void {
    this.buffer.push(event)
    if (this.buffer.length >= flushBatchSize()) {
      this.flush()
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return
    const lines = this.buffer.map(e => JSON.stringify(e)).join('\n') + '\n'
    appendFileSync(this.filePath, lines)
    this.buffer = []
  }

  readEvents(): SessionEvent[] {
    // 流式读取所有 JSONL 行
  }
}
```

### 10.2 Flush 策略

```typescript
function flushBatchSize(): number {
  return parseInt(process.env.PERSIST_FLUSH_BATCH ?? '10')
}

function flushIntervalMs(): number {
  return parseInt(process.env.PERSIST_FLUSH_INTERVAL_MS ?? '1000')
}
```

定时 flush 由 `setInterval` 驱动，进程退出前强制 flush。

---

## 11. 调度器设计

### 11.1 时间轮

```typescript
// src/scheduler/wheel.ts

const TICK_COUNT = 27  // 复刻 Rust 版

export class TimeWheel {
  private buckets: (ScheduledTask | null)[][] = Array(TICK_COUNT)
    .fill(null)
    .map(() => [null])
  private currentTick = 0
  private nextRotation = 1

  schedule(task: ScheduledTask, delayMs: number): void {
    const targetTick = Math.ceil(delayMs / 1000)
    const bucketIdx = (this.currentTick + targetTick) % TICK_COUNT
    const rotation = this.nextRotation + Math.floor(targetTick / TICK_COUNT)
    this.buckets[bucketIdx].push({ ...task, rotation })
  }

  tick(): ScheduledTask[] {
    const current = this.buckets[this.currentTick]
    this.buckets[this.currentTick] = [null]
    this.currentTick = (this.currentTick + 1) % TICK_COUNT
    if (this.currentTick === 0) this.nextRotation++

    const due: ScheduledTask[] = []
    for (const t of current) {
      if (t && t.rotation <= this.nextRotation) due.push(t)
    }
    return due
  }
}
```

---

## 12. Web 层设计

### 12.1 Express 路由

```typescript
// src/web/router.ts

export function buildRouter(state: AppState): Express {
  const app = express()
  app.use(cors())
  app.use(express.json())

  // 状态/模型
  app.get('/api/status', statusHandler)
  app.get('/api/models', modelsListHandler)
  app.post('/api/models', modelsSaveHandler)
  app.delete('/api/models/:name', modelsDeleteHandler)
  app.post('/api/models/switch', modelsSwitchHandler)

  // 会话
  app.get('/api/sessions', sessionsListHandler)
  app.get('/api/sessions/:id', sessionsGetHandler)
  app.delete('/api/sessions/:id', sessionsDeleteHandler)
  app.post('/api/sessions/:id/rename', sessionsRenameHandler)
  app.get('/api/sessions/:id/export', sessionsExportHandler)

  // 文件
  app.get('/api/files', filesListHandler)
  app.get('/api/files/content', filesGetContentHandler)
  app.post('/api/files/save', filesSaveHandler)

  // 技能
  app.get('/api/skills', skillsListHandler)
  app.post('/api/skills/install', skillsInstallHandler)
  app.post('/api/skills/preview', skillsPreviewHandler)
  app.delete('/api/skills/:name', skillsRemoveHandler)

  // WebSocket
  app.get('/ws/chat', chatWsHandler)

  // 静态资源
  app.use('/static', serveStatic(staticDir))

  return app
}
```

### 12.2 WebSocket 协议

客户端 → 服务端：
- `{ type: 'user_message', content, id? }`
- `{ type: 'cancel', messageId? }`

服务端 → 客户端（流式事件）：
- `{ type: 'thinking', content }`
- `{ type: 'tool_call', toolName, args }`
- `{ type: 'tool_result', toolName, success, content }`
- `{ type: 'assistant_stream_delta', delta, isFinal }`
- `{ type: 'reasoning_delta', delta, isFinal }`
- `{ type: 'assistant_message', content, streaming? }`
- `{ type: 'token_usage', promptTokens, completionTokens, totalTokens }`
- `{ type: 'error', content }`
- `{ type: 'status', content }`
- `{ type: 'session_ready', sessionId }`
- `{ type: 'done', messageId? }`

---

## 13. CLI 设计

### 13.1 参数映射

```typescript
// src/main.ts

program
  .option('--message <msg>', '一次性执行消息')
  .option('--project <dir>', '项目目录', '.')
  .option('--config <path>', '模型配置文件')
  .option('--provider <name>', '覆盖 provider', 'openai')
  .option('--model <name>', '覆盖模型名')
  .option('--no-approval', '关闭审批')
  .option('--no-hooks', '禁用 hook')
  .option('--hooks-dry-run', '预览 hook 不执行')
  .option('--verbose', '详细日志')
  .option('--max-iterations <n>', '最大迭代次数')
  .option('--max-tokens <n>', '上下文窗口 token 数', 262144)
  .option('--resume', '恢复会话')
  .option('--background', '后台模式')
  .option('--web', '启动 Web 服务')
  .option('--port <port>', 'Web 端口', 8080)
  .option('--host <host>', 'Web 主机', '127.0.0.1')
```

### 13.2 子命令

- `init` — 交互式配置模型
- `skill add|list|remove|update` — 技能管理

---

## 14. 包与依赖

```json
{
  "name": "dev-assistant-ts",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/main.js",
  "bin": { "dev-assistant": "dist/main.js" },
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "build": "tsx scripts/build.ts",
    "dev": "tsx src/main.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "express": "^5.1.0",
    "ws": "^8.18.0",
    "undici": "^7.0.0",
    "smol-toml": "^1.3.0",
    "picomatch": "^4.0.0",
    "fast-glob": "^3.3.0",
    "shiki": "^3.0.0",
    "marked": "^15.0.0",
    "ink": "^5.0.0",
    "ink-spinner": "^5.0.0",
    "chalk": "^5.4.0",
    "pino": "^9.0.0",
    "pino-pretty": "^13.0.0",
    "graceful-fs": "^4.2.11",
    "uuid": "^11.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^6.0.0",
    "tsx": "^4.19.0",
    "vitest": "^3.0.0",
    "eslint": "^9.0.0",
    "@eslint/js": "^9.0.0",
    "typescript-eslint": "^8.0.0"
  }
}
```

**关于 ink**：ink v5 是 React for CLIs，支持流式渲染、布局、颜色。用它复刻 Rust 版的 ratatui 状态栏 + Markdown 渲染。

---

## 15. 测试策略

### 15.1 测试金字塔

| 层级 | 工具 | 范围 |
|---|---|---|
| 单元测试 | vitest | 纯函数（重试、参数解析、token 估算、时间轮） |
| 集成测试 | vitest + mock server | LLM provider 调用、工具执行、持久化 |
| E2E 测试 | 手动 + 脚本 | CLI 完整流程、Web API |

### 15.2 Mock LLM Server

```typescript
// test/fixtures/mock-llm-server.ts

// 用 express 模拟 OpenAI 协议
// 支持流式 SSE 响应、工具调用响应、错误响应
// 通过环境变量 OPENAI_API_BASE 注入到 LlmClient
```

### 15.3 关键测试用例

- `retry.test.ts` — 429 重试、网络错误重试、致命错误不重试
- `provider-openai.test.ts` — SSE 解析、工具调用、reasoning 字段
- `tool-read-file.test.ts` — 行号范围、二进制文件、超大文件
- `tool-exec-command.test.ts` — 超时、危险命令拦截
- `scheduler-wheel.test.ts` — 时间轮调度、跨轮任务
- `session-store.test.ts` — JSONL 写入、flush 策略、读取
- `agent-loop.test.ts` — 多轮迭代、工具调用、finish 终止
- `context-compress.test.ts` — 压缩前后 token 变化

---

## 16. 实现阶段计划

### Phase 1: 项目脚手架 + LLM 客户端（3-4 天）

**目标**: 能调用 LLM 的 CLI

- 初始化 package.json、tsconfig、eslint、vitest
- 实现 `src/utils/error.ts`、`src/utils/atomic-write.ts`
- 实现 `src/llm/models.ts` 全部类型
- 实现 `src/llm/provider/common.ts` + `factory.ts`
- 实现 `src/llm/provider/openai.ts`（含 SSE 流式解析）
- 实现 `src/llm/provider/ollama.ts`（OpenAI 兼容）
- 实现 `src/llm/provider/anthropic.ts`（独立协议）
- 实现 `src/llm/retry.ts`（三类错误 + 退避）
- 实现 `src/llm/client.ts`（多 provider 故障转移）
- 实现 `src/config/index.ts`（TOML 加载 + 环境变量解析）
- 实现 `src/main.ts`（commander + 最小 CLI）

**验证**: `npm run dev -- --message "hello" --model gpt-4o` 能输出回复

### Phase 2: 工具系统核心 + Agent 主循环（5-7 天）

**目标**: 能读写文件的 Agent

- 实现 `src/tools/registry.ts`、`common.ts`、`error.ts`、`cache.ts`、`spec.ts`
- 实现 8 个文件工具（read_file/write_file/edit_file/glob/list_directory/file_exists/batch_read_files/read_symbol）
- 实现 `src/tools/system/exec-command.ts`
- 实现 `src/tools/meta/finish.ts`、`restart.ts`、`run-hook.ts`
- 实现 `src/security/policy.ts`、`approval.ts`、`types.ts`
- 实现 `src/persist/events.ts`、`session-store.ts`
- 实现 `src/agent/context.ts`、`token-counter.ts`
- 实现 `src/agent/agent.ts`（主循环 + 工具执行 + finish 检测）
- 实现 `src/repl.ts`（交互循环）

**验证**: Agent 能根据指令读写文件、执行命令、正常终止

### Phase 3: 上下文管理 + 子代理 + CLI UI（5-7 天）

**目标**: 完整单轮 Agent

- 实现 `src/agent/compressor.ts`、`summary.ts`
- 实现 `src/agent/memory.ts`
- 实现 `src/tools/subagent/spawn-subagent.ts`
- 实现 `src/tools/context-budget/` 三个工具
- 实现 `src/ui/theme.ts`、`status-bar.ts`、`markdown.ts`、`input.ts`（ink）
- 实现 `src/prompt.ts`（系统提示词模板）
- 实现 `src/skills/`（加载已安装技能）
- 实现 `src/hooks/`（session-start hook）

**验证**: 长对话能自动压缩、子代理能派生、CLI 渲染流畅

### Phase 4: 知识库 + 任务 + 分析工具（5-7 天）

**目标**: 长期记忆能力

- 实现 `src/tools/kb/kb-store.ts`、`kb-query.ts`
- 实现 `src/tools/task/` 四个工具
- 实现 `src/tools/analysis/` 四个工具
- 实现 `src/orchestrator/`（可选，崩溃恢复）
- 实现 `src/dream/`（记忆固化，P2 可选）

**验证**: Agent 能存储知识、管理任务、分析代码库

### Phase 5: Web 层 + 调度器 + 技能管理（5-7 天）

**目标**: 完整等价功能

- 实现 `src/web/server.ts`、`router.ts`
- 实现 `src/web/routes/` 全部
- 实现 `src/web/ws/events.ts`、`chat.ts`
- 实现 `src/web/static.ts`
- 实现 `src/scheduler/` 全部（engine/executor/handler/wheel/store）
- 实现 `src/tools/scheduler/` 四个工具
- 实现 `src/skills/installer.ts`（Git 克隆）
- 实现 `src/env-info.ts`
- 集成测试 + E2E 测试

**验证**: Web UI 可访问、调度器能定时执行、技能能安装

### Phase 6: 嵌入 devworkbench（3-5 天）

**目标**: 嵌入完成

- 作为 `devworkbench/src/main/assistant/` 模块
- 复用 devworkbench 的 IPC 通道（`assistant:*` 命名空间）
- 复用 devworkbench 的设置页（模型配置）
- 新增"AI 助手"工作区（webview 或原生 UI）

**验证**: devworkbench 内能启动 AI 助手、读写知识库笔记

---

## 17. 技术风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| ink v5 API 不稳定 | CLI 渲染崩溃 | 锁定版本 + 降级方案（chalk 纯输出） |
| tree-sitter npm 包编译失败 | read_symbol 不可用 | Phase 1-4 用启发式解析；Phase 5 再评估 |
| undici SSE 解析边界情况 | 流式响应错位 | 单元测试覆盖多种 SSE 格式 |
| Anthropic 协议差异 | 工具调用格式不同 | 单独实现 provider，不强行复用 OpenAI 协议 |
| JSONL 大文件性能 | 会话历史读取慢 | 流式读取 + 索引（可选 Phase 5） |
| 时间轮漂移 | 调度不准 | 用 `Date.now()` 校准，不依赖 setInterval 精度 |
| Windows 路径处理 | 路径分隔符错误 | 统一用 `path.join` + `path.resolve` |
| 并发工具执行 | 状态竞争 | ToolRegistry 用单线程模型，工具执行用 Promise.all 但上下文修改串行化 |

---

## 18. 与 dev-assistant-rs 的对照表

| 模块 | Rust 文件 | TS 文件 | 状态 |
|---|---|---|---|
| CLI 入口 | `src/main.rs` | `src/main.ts` | 待实现 |
| App 组装 | `src/app.rs` | `src/app.ts` | 待实现 |
| REPL | `src/repl.rs` | `src/repl.ts` | 待实现 |
| 系统提示词 | `src/prompt.rs` | `src/prompt.ts` | 待实现 |
| LLM 客户端 | `src/llm/client.rs` | `src/llm/client.ts` | 待实现 |
| LLM 模型 | `src/llm/models.rs` | `src/llm/models.ts` | 待实现 |
| LLM Provider | `src/llm/provider/` | `src/llm/provider/` | 待实现 |
| Agent 主循环 | `src/agent/mod.rs` | `src/agent/agent.ts` | 待实现 |
| 上下文管理 | `src/agent/context.rs` | `src/agent/context.ts` | 待实现 |
| 上下文压缩 | `src/agent/compressor.rs` | `src/agent/compressor.ts` | 待实现 |
| 摘要 | `src/agent/summary.rs` | `src/agent/summary.ts` | 待实现 |
| 记忆 | `src/agent/memory.rs` | `src/agent/memory.ts` | 待实现 |
| Token 计数 | `src/agent/token_counter.rs` | `src/agent/token-counter.ts` | 待实现 |
| 工具注册表 | `src/tools/mod.rs` | `src/tools/registry.ts` | 待实现 |
| 文件工具 | `src/tools/file/` | `src/tools/file/` | 待实现 |
| 系统工具 | `src/tools/system_tools.rs` | `src/tools/system/` | 待实现 |
| 元工具 | `src/tools/meta_tools.rs` | `src/tools/meta/` | 待实现 |
| 子代理 | `src/tools/subagent.rs` | `src/tools/subagent/` | 待实现 |
| 知识库 | `src/tools/kb.rs` | `src/tools/kb/` | 待实现 |
| 任务 | `src/tools/task_tools.rs` | `src/tools/task/` | 待实现 |
| 分析 | `src/tools/analysis.rs` | `src/tools/analysis/` | 待实现 |
| 调度工具 | `src/scheduler/tools_handlers.rs` | `src/tools/scheduler/` | 待实现 |
| 上下文工具 | `src/tools/context_budget.rs` | `src/tools/context-budget/` | 待实现 |
| 调度器 | `src/scheduler/` | `src/scheduler/` | 待实现 |
| 安全 | `src/security/` | `src/security/` | 待实现 |
| 会话 | `src/session/` | `src/session/` | 待实现 |
| 技能 | `src/skills/` | `src/skills/` | 待实现 |
| Hooks | `src/hooks/` | `src/hooks/` | 待实现 |
| Dream | `src/dream/` | `src/dream/` | 待实现 |
| 持久化 | `src/persist/` | `src/persist/` | 待实现 |
| Web 服务 | `src/web/` | `src/web/` | 待实现 |
| CLI UI | `src/ui/` | `src/ui/` | 待实现 |
| 工具函数 | `src/utils/` | `src/utils/` | 待实现 |

---

## 附录 A: 关键算法速查

### A.1 Token 估算

简单估算：每 4 字符约 1 token（英文），中文约 1.5 字 1 token。Phase 3 可换成 `gpt-tokenizer` 精确计数。

### A.2 退避抖动

```
delay = base * multiplier^(attempt-1) + random(0, base*0.25)
```

### A.3 时间轮槽位

```
bucketIdx = (currentTick + delaySeconds) % 27
rotation = nextRotation + floor(delaySeconds / 27)
```

### A.4 JSONL Flush

```
if buffer.length >= flushBatchSize || timeSinceLastFlush > flushIntervalMs:
  appendFileSync(filePath, buffer.map(JSON.stringify).join('\n'))
  buffer.clear()
```

---

## 附录 B: 与 devworkbench 的集成接口（预留）

```typescript
// 未来嵌入 devworkbench 时暴露的 API

export interface AssistantModule {
  start(options: {
    workingDir: string
    port?: number
    host?: string
    modelConfigs: ProviderConfig[]
  }): Promise<void>

  stop(): Promise<void>

  getStatus(): { running: boolean; port: number; url: string }

  on(event: 'event', callback: (e: ServerEvent) => void): void
}
```

嵌入时通过 devworkbench 的 `electron/ipc/assistant.ts` 调用，前端通过 `window.electronAPI.assistant.*` 访问。

---
