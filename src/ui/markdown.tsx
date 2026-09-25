import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'

/**
 * Markdown 渲染（ink 组件，对齐设计文档 ui/markdown.ts）。
 *
 * 策略：用 marked 把 Markdown 转成带结构标记的纯文本，
 * 再用简单的 ANSI 行高亮（ink <Text> 逐行着色）：
 * - 标题 → 加粗 + 主色
 * - 行内代码 → 黄底风格（下划线近似）
 * - 代码块 → dim + 缩进
 * - 引用 → dim
 * - 列表项 → 主色符号
 *
 * 说明：终端 ink 无法做完整富文本布局，这里做"可读化"而非像素级渲染；
 * 完整高亮（shiki）留给 Web 层。
 */

export interface MarkdownProps {
  content: string
  /** 最大渲染行数（超出截断） */
  maxLines?: number
}

/** 把 markdown 渲染为带 ink 着色的 React 元素树 */
export function Markdown({ content, maxLines = 200 }: MarkdownProps): React.ReactElement {
  const lines = renderToAnsiLines(content)
  const shown = lines.slice(0, maxLines)
  const more = lines.length - shown.length

  return (
    <Box flexDirection="column">
      {shown.map((line, i) => (
        <Text key={i} color={line.color} bold={line.bold} dimColor={line.dim}>
          {line.text}
        </Text>
      ))}
      {more > 0 && <Text color={theme.dim}>…（共 {lines.length} 行，仅显示前 {maxLines}）</Text>}
    </Box>
  )
}

interface AnsiLine {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
}

/** 渲染为逐行着色结构（纯函数，可单测） */
export function renderToAnsiLines(markdown: string): AnsiLine[] {
  const rawLines = markdown.split('\n')
  const out: AnsiLine[] = []
  let inCodeBlock = false

  for (const raw of rawLines) {
    const line = raw.trimEnd()

    // 代码块围栏
    if (/^```/.test(line.trim())) {
      inCodeBlock = !inCodeBlock
      out.push({ text: line, dim: true, color: theme.dim })
      continue
    }
    if (inCodeBlock) {
      out.push({ text: `  ${line || ''}`, dim: true })
      continue
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      out.push({ text: `${h[1]} ${h[2]}`, bold: true, color: theme.primary })
      continue
    }
    // 引用
    if (/^>\s?/.test(line)) {
      out.push({ text: line, dim: true })
      continue
    }
    // 列表项
    const li = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
    if (li) {
      out.push({ text: `${li[1]}• ${li[3]}`, color: theme.dim })
      continue
    }
    // 分隔线
    if (/^(-{3,}|\*{3,})\s*$/.test(line.trim())) {
      out.push({ text: '─'.repeat(40), dim: true })
      continue
    }

    // 普通行：含行内代码 → 黄
    if (/`[^`]+`/.test(line)) {
      out.push({ text: line, color: 'yellow' })
      continue
    }
    out.push({ text: line })
  }

  // 若末尾仍在代码块中（未闭合），保持 dim
  return out
}

export default Markdown
