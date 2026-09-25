# dev-assistant-ts

纯 Node.js/TypeScript 实现的 AI 编程代理框架，功能完整复刻 [dev-assistant-rs](https://gitlab.com)（27 个工具 + 9 个子系统）。零原生依赖，跨 macOS/Windows/Linux。

> 设计文档见 [docs/design.md](docs/design.md)。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置模型
cp .dev-assistant-models.toml.example .dev-assistant-models.toml
# 编辑 .dev-assistant-models.toml，填入 API 密钥（支持 ${ENV_VAR} 占位符）

# 3. 运行
npm run dev -- --message "hello" --model gpt-4o
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | tsx 直接运行 CLI（开发模式） |
| `npm run dev -- --message "…"` | 一次性执行消息 |
| `npm run dev -- --web --port 8080` | 启动 Web 服务（Phase 5） |
| `npm run build` | 构建到 `dist/` |
| `npm test` | vitest 运行全部测试 |
| `npm run typecheck` | tsc --noEmit |
| `npm run lint` | eslint |

## 开发状态

- [x] Phase 1: 脚手架 + LLM 客户端
- [x] Phase 2: 工具系统核心 + Agent 主循环
- [x] Phase 3: 上下文管理 + 子代理 + CLI UI
- [x] Phase 4: 知识库 + 任务 + 分析工具
- [x] Phase 5: Web 层 + 调度器 + 技能管理
- [x] Phase 6: 嵌入 devworkbench（`dev-assistant-ts/embed` 模块）
