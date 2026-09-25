import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'

/**
 * 输入框（ink 组件，对齐设计文档 ui/input.ts）。
 *
 * 功能：
 * - 单行文本输入 + 光标
 * - Enter 提交（onSubmit），空输入忽略
 * - Backspace 删除
 * - Ctrl+C 退出（onExit）
 * - 基础方向键左右移动光标
 * - 历史：↑/↓ 翻历史（提交过的非命令消息）
 *
 * ink 接管 raw 输入，REPL 主循环改为"渲染组件 → 回调驱动"模型。
 */

export interface InputProps {
  /** 提示符（如 "你 › "） */
  prompt?: string
  onSubmit: (text: string) => void | Promise<void>
  onExit?: () => void
  /** 禁用（Agent 运行中不接受输入） */
  disabled?: boolean
  /** 占位提示（输入为空时显示） */
  placeholder?: string
}

const MAX_LINE = 2000

export function Input(props: InputProps): React.ReactElement {
  const prompt = props.prompt ?? '你 › '
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [busy, setBusy] = useState(false)
  const historyRef = React.useRef<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)

  useInput(
    (input, key) => {
      if (props.disabled || busy) return

      // Ctrl+C / Ctrl+D 退出
      if (key.ctrl && (input === 'c' || input === 'd')) {
        props.onExit?.()
        return
      }
      if (key.ctrl) return

      // Enter 提交
      if (key.return) {
        const text = value.trim()
        if (!text) return
        // 记入历史（非 / 命令也记，方便回看）
        historyRef.current.push(value)
        setHistoryIdx(-1)
        setValue('')
        setCursor(0)
        setBusy(true)
        Promise.resolve(props.onSubmit(text))
          .catch(() => undefined)
          .finally(() => setBusy(false))
        return
      }

      // 历史
      if (key.upArrow) {
        const h = historyRef.current
        if (h.length === 0) return
        const idx = historyIdx === -1 ? h.length - 1 : Math.max(0, historyIdx - 1)
        setHistoryIdx(idx)
        setValue(h[idx] ?? '')
        setCursor((h[idx] ?? '').length)
        return
      }
      if (key.downArrow) {
        const h = historyRef.current
        if (historyIdx === -1) return
        const idx = historyIdx + 1
        if (idx >= h.length) {
          setHistoryIdx(-1)
          setValue('')
          setCursor(0)
        } else {
          setHistoryIdx(idx)
          setValue(h[idx] ?? '')
          setCursor((h[idx] ?? '').length)
        }
        return
      }

      // 光标移动
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1))
        return
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1))
        return
      }
      if (key.home) {
        setCursor(0)
        return
      }
      if (key.end) {
        setCursor(value.length)
        return
      }

      // 删除
      if (key.backspace) {
        if (cursor === 0) return
        setValue(value.slice(0, cursor - 1) + value.slice(cursor))
        setCursor(cursor - 1)
        return
      }
      if (key.delete) {
        setValue(value.slice(0, cursor) + value.slice(cursor + 1))
        return
      }

      // 普通字符
      if (input && !key.ctrl && !key.meta) {
        if (value.length >= MAX_LINE) return
        setValue(value.slice(0, cursor) + input + value.slice(cursor))
        setCursor(cursor + 1)
      }
    },
    { isActive: !props.disabled },
  )

  const before = value.slice(0, cursor)
  const after = value.slice(cursor)

  return (
    <Box>
      <Text color={theme.user} bold>
        {prompt}
      </Text>
      {value.length === 0 ? (
        <Text color={theme.dim}>{props.placeholder ?? ''}</Text>
      ) : (
        <Text>
          {before}
          <Text inverse>
            {after.length > 0 ? after.slice(0, 1) : ' '}
          </Text>
          {after.slice(1)}
        </Text>
      )}
      {busy && <Text color={theme.dim}> ⏳</Text>}
    </Box>
  )
}

export default Input
