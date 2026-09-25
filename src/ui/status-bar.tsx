import React from 'react'
import { Box, Text } from 'ink'
import { theme, pressureColor } from './theme.js'

/**
 * 状态栏（ink 组件，对齐设计文档 ui/status-bar.ts）。
 * 显示：上下文占用条、消息数、当前 provider/模型、会话 id 前缀。
 */

export interface StatusBarProps {
  /** token 占用比（0-1） */
  ratio: number
  pressure: 'low' | 'medium' | 'high' | 'critical'
  /** 消息条数 */
  messageCount: number
  /** 活跃 provider 名 */
  providerName?: string
  /** 模型名 */
  model?: string
  /** 会话 id（截断显示） */
  sessionId?: string
  /** 当前轮次提示（如 "第 3/10 轮"） */
  iterationHint?: string
}

const BAR_WIDTH = 12

function bar(ratio: number): string {
  const filled = Math.min(BAR_WIDTH, Math.round(Math.min(1, Math.max(0, ratio)) * BAR_WIDTH))
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const color = pressureColor(props.pressure)
  return (
    <Box borderColor={color} borderStyle="round" paddingX={1} justifyContent="space-between">
      <Text>
        <Text color={color}>{bar(props.ratio)}</Text>{' '}
        <Text color={color}>{(props.ratio * 100).toFixed(0)}%</Text>
      </Text>
      <Text color={theme.dim}>
        {props.messageCount} 条消息
        {props.providerName ? ` · ${props.providerName}` : ''}
        {props.model ? `/${props.model}` : ''}
        {props.sessionId ? ` · ${props.sessionId.slice(0, 13)}…` : ''}
        {props.iterationHint ? ` · ${props.iterationHint}` : ''}
      </Text>
    </Box>
  )
}

export default StatusBar
