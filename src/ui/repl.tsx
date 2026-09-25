import React, { useCallback, useEffect, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { Markdown } from './markdown.js'
import { StatusBar } from './status-bar.js'
import { Input } from './input.js'
import { theme, banner } from './theme.js'
import type { ApprovalRequestInfo, ApprovalBridge } from './bridge.js'
import type { App } from '../app.js'
import type { AgentEvent } from '../agent/agent.js'
import { log } from '../utils/logger.js'

/**
 * 交互式 REPL（ink 组件版，对齐设计文档 ui/）。
 *
 * 模型：Agent 运行时禁用输入；每轮结果以 Markdown 渲染；
 * 状态栏显示上下文压力（onContextChanged / tokenUsage 事件刷新）。
 *
 * 非 TTY 场景由 main.ts 降级到纯文本 REPL（repl.ts）。
 */

export interface InkReplProps {
  app: App
  /** 审批桥（UI 内交互审批；缺省时无审批交互） */
  approvalBridge?: ApprovalBridge
  /** 退出回调（Ctrl+C / /quit） */
  onExit?: () => void
}

interface AssistantBlock {
  id: number
  content: string
}

interface ToolLine {
  id: number
  name: string
  success?: boolean
  preview?: string
}

export function InkRepl({ app, approvalBridge, onExit }: InkReplProps): React.ReactElement {
  const { exit } = useApp()
  const [blocks, setBlocks] = useState<AssistantBlock[]>([])
  const [tools, setTools] = useState<ToolLine[]>([])
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [ratio, setRatio] = useState(0)
  const [pressure, setPressure] = useState<'low' | 'medium' | 'high' | 'critical'>('low')
  const [msgCount, setMsgCount] = useState(0)
  const [iterationHint, setIterationHint] = useState('')
  const [approval, setApproval] = useState<ApprovalRequestInfo | null>(null)

  const idRef = React.useRef(1)

  const quit = useCallback(() => {
    onExit?.()
    exit()
  }, [onExit, exit])

  const refreshBudget = useCallback(() => {
    try {
      const b = app.agent.getContext().budget()
      setRatio(b.ratio)
      setPressure(b.pressure)
      setMsgCount(app.agent.getContext().toMessages().length)
    } catch {
      // App 未就绪
    }
  }, [app])

  const onEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.kind) {
        case 'assistantStreamDelta':
          setStreaming((s) => s + event.content)
          break
        case 'toolCall':
          setTools((t) => [
            ...t,
            { id: idRef.current++, name: event.call.function.name, preview: event.call.function.arguments.slice(0, 120) },
          ])
          break
        case 'toolResult':
          setTools((t) => {
            const last = t[t.length - 1]
            if (last) {
              return [...t.slice(0, -1), { ...last, success: event.result.success, preview: event.result.content.replace(/\n/g, ' ').slice(0, 120) }]
            }
            return t
          })
          break
        case 'status':
          setIterationHint(event.content)
          refreshBudget()
          break
        case 'tokenUsage':
          refreshBudget()
          break
        default:
          break
      }
    },
    [refreshBudget],
  )

  // 把 Agent 流式事件接到本组件
  useEffect(() => {
    app.setOnEvent(onEvent)
    return () => app.setOnEvent(() => undefined)
  }, [app, onEvent])

  // 订阅审批请求（UI 内 [y/N]）
  useEffect(() => {
    approvalBridge?.subscribe(setApproval)
  }, [approvalBridge])

  // 审批键盘响应
  useInput(
    (input, key) => {
      if (!approval || !approvalBridge) return
      if (key.return || input === 'y' || input === 'Y' || input === '是') {
        approvalBridge.answer(true)
      } else if (key.escape || input === 'n' || input === 'N') {
        approvalBridge.answer(false)
      }
    },
    { isActive: approval !== null },
  )

  const handleSubmit = useCallback(
    async (text: string) => {
      if (text === '/quit' || text === '/exit' || text === '/q') {
        quit()
        return
      }
      if (text === '/status') {
        const b = app.agent.getContext().budget()
        setBlocks((bs) => [
          ...bs,
          {
            id: idRef.current++,
            content: `**会话状态**\n- 会话 ID: \`${app.sessionId}\`\n- 上下文: ${b.current}/${b.max} tokens（${(b.ratio * 100).toFixed(1)}%，${b.pressure}）\n- 消息数: ${b.current > 0 ? app.agent.getContext().toMessages().length : 0}\n- 审批: ${app.approval.isDisabled() ? '关闭' : '启用'}\n- hooks: ${app.hooks.isEnabled() ? `启用（${app.hooks.list().length}）` : '禁用'}\n- 工具数: ${app.tools.listNames().length}\n- 记忆: ${app.memory.size} 条`,
          },
        ])
        return
      }
      if (text === '/tools') {
        const names = app.tools.listNames()
        setBlocks((bs) => [...bs, { id: idRef.current++, content: `**已注册工具（${names.length}）**\n${names.map((n) => `- ${n}`).join('\n')}` }])
        return
      }
      if (text === '/help') {
        setBlocks((bs) => [
          ...bs,
          { id: idRef.current++, content: '**命令**\n- `/status` 会话状态\n- `/tools` 工具列表\n- `/quit` 退出\n\n其他输入将作为消息发送给 Agent。' },
        ])
        return
      }

      setBusy(true)
      setStreaming('')
      setIterationHint('思考中…')
      try {
        const result = await app.run(text)
        if (result.message) {
          setBlocks((bs) => [...bs, { id: idRef.current++, content: result.message }])
        }
        if (!result.success) {
          log.debug('任务结果', { success: result.success, finished: result.finished, iterations: result.iterations })
        }
      } catch (e) {
        setBlocks((bs) => [...bs, { id: idRef.current++, content: `**错误**\n\`${e instanceof Error ? e.message : String(e)}\`` }])
      } finally {
        setBusy(false)
        setStreaming('')
        setIterationHint('')
        refreshBudget()
      }
    },
    [app, exit, refreshBudget],
  )

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={theme.primary} bold>
          {banner()}
        </Text>
      </Box>

      {blocks.map((b) => (
        <Box key={b.id} flexDirection="column" marginBottom={1}>
          <Text color={theme.assistant}>
            <Markdown content={b.content} maxLines={80} />
          </Text>
        </Box>
      ))}

      {tools.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {tools.slice(-5).map((t) => (
            <Text key={t.id} color={t.success === undefined ? theme.tool : t.success ? theme.success : theme.error}>
              🔧 {t.name}{t.success !== undefined ? (t.success ? ' ✓' : ' ✗') : ' …'}
            </Text>
          ))}
        </Box>
      )}

      {streaming.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Markdown content={streaming} maxLines={60} />
        </Box>
      )}

      <StatusBar
        ratio={ratio}
        pressure={pressure}
        messageCount={msgCount}
        sessionId={app.sessionId}
        iterationHint={iterationHint || undefined}
      />
      {approval && (
        <Box marginTop={1} borderColor={theme.approval} borderStyle="round" paddingX={1}>
          <Text color={theme.approval} bold>
            ⚠️ 审批请求：危险级别 {approval.dangerLevel} · 类型 {approval.approvalType} · 作用域 {approval.scope}
          </Text>
          <Text color={theme.approval}> 允许执行？(y/N)</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Input prompt="你 › " onSubmit={handleSubmit} onExit={quit} disabled={busy || approval !== null} placeholder="输入消息…（/help 查看命令）" />
      </Box>
    </Box>
  )
}

export default InkRepl
