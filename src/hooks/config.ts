import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'
import { AppError } from '../utils/error.js'
import type { HookDefinition, HookEvent } from './types.js'

/**
 * Hook 配置加载（`.dev-assistant-hooks.toml`）。
 *
 * 格式：
 *   [[hooks]]
 *   name = "notify"
 *   event = "agent-done"
 *   command = "osascript -e 'display notification ...'"
 *   timeout_secs = 30
 *   inject_output = false
 */

export const DEFAULT_HOOKS_FILE = '.dev-assistant-hooks.toml'

const VALID_EVENTS: HookEvent[] = ['session-start', 'pre-tool', 'post-tool', 'agent-done']

export function parseHooksConfig(tomlText: string): HookDefinition[] {
  let raw: unknown
  try {
    raw = parse(tomlText)
  } catch (e) {
    throw AppError.Config(`hook 配置 TOML 解析失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  const root = raw as Record<string, unknown>
  const arr = root.hooks
  if (!Array.isArray(arr)) return [] // 无 hooks 节 = 空列表（不报错）

  return arr.map((item, i) => {
    if (typeof item !== 'object' || item === null) {
      throw AppError.Config(`[[hooks]] 第 ${i + 1} 条不是表`)
    }
    const t = item as Record<string, unknown>
    const name = requireStr(t.name, `hooks[${i}].name`)
    const event = requireStr(t.event, `hooks[${i}].event`)
    if (!VALID_EVENTS.includes(event as HookEvent)) {
      throw AppError.Config(`hooks[${i}].event 取值非法: ${event}（可选: ${VALID_EVENTS.join(', ')}）`)
    }
    const command = requireStr(t.command, `hooks[${i}].command`)
    const timeoutSecs = t.timeout_secs !== undefined ? Number(t.timeout_secs) : undefined
    const def: HookDefinition = {
      name,
      event: event as HookEvent,
      command,
    }
    if (typeof t.tool === 'string') def.tool = t.tool
    if (timeoutSecs !== undefined && Number.isFinite(timeoutSecs) && timeoutSecs > 0) def.timeoutSecs = Math.floor(timeoutSecs)
    if (typeof t.inject_output === 'boolean') def.injectOutput = t.inject_output
    return def
  })
}

/** 从工作目录加载 hook 配置；文件不存在返回空 */
export async function loadHooksConfig(workingDir: string, explicitPath?: string): Promise<HookDefinition[]> {
  const file = explicitPath ? path.resolve(explicitPath) : path.join(workingDir, DEFAULT_HOOKS_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw AppError.Config(`无法读取 hook 配置 ${file}: ${e instanceof Error ? e.message : String(e)}`)
  }
  return parseHooksConfig(text)
}

function requireStr(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw AppError.Config(`hook 配置缺少必填字段 ${field}（非空字符串）`)
  }
  return v.trim()
}
