import { DANGER_WEIGHT, type ApprovalRequirement, type DangerLevel, type SecurityEvaluation } from './types.js'
import type { ToolSpec } from '../tools/spec.js'

/**
 * SecurityPolicy：根据工具 spec + 实际参数评估危险级别与审批要求。
 * 对齐设计文档 9 节：
 * - low      读文件、列目录、glob → 自动通过
 * - medium   任务控制、子代理     → 会话级审批（30 分钟）
 * - high     写文件、执行 hook    → 会话级审批（1 小时）
 * - critical 执行 shell 命令      → 一次性审批（每次确认）
 */

/** 各危险级别默认审批配置 */
const DEFAULT_APPROVAL: Record<DangerLevel, { type: 'auto' | 'one-time' | 'session'; validitySeconds: number }> = {
  low: { type: 'auto', validitySeconds: 0 },
  medium: { type: 'session', validitySeconds: 30 * 60 },
  high: { type: 'session', validitySeconds: 60 * 60 },
  critical: { type: 'one-time', validitySeconds: 0 },
}

/**
 * 评估工具调用。
 * @param spec 工具固有安全策略
 * @param args 实际参数（用于 dynamic 规则，如 exec_command 的命令内容）
 */
export function evaluateTool(spec: ToolSpec, args: Record<string, unknown>): SecurityEvaluation {
  let level = spec.dangerLevel
  const reasons: string[] = []

  // 动态升级：exec_command 根据命令内容判定
  if (spec.name === 'exec_command') {
    const cmd = typeof args.command === 'string' ? args.command : ''
    const danger = classifyCommand(cmd)
    if (DANGER_WEIGHT[danger] > DANGER_WEIGHT[level]) {
      level = danger
      reasons.push(`命令风险: ${danger}`)
    }
  }

  // 动态升级：写操作目标路径敏感（.git、系统目录等）
  if (level === 'high' && (spec.name === 'write_file' || spec.name === 'edit_file')) {
    const path = typeof args.path === 'string' || typeof args.file_path === 'string'
      ? ((args.path ?? args.file_path) as string)
      : ''
    if (isSensitivePath(path)) {
      reasons.push(`敏感路径: ${path}`)
    }
  }

  const approval = DEFAULT_APPROVAL[level]
  const approvalRequirement: ApprovalRequirement = {
    approvalType: spec.approvalType ?? approval.type,
    dangerThreshold: level,
    requiresUserConfirmation: (spec.approvalType ?? approval.type) !== 'auto',
    validitySeconds: spec.validitySeconds ?? approval.validitySeconds,
    scope: spec.approvalScope ?? 'none',
  }

  if (reasons.length === 0) {
    reasons.push(`固有级别: ${level}`)
  }

  return { dangerLevel: level, reasons, approvalRequirement }
}

/**
 * 审批作用域 key：按 spec.approvalScope 从参数中提取。
 * - command: 命令字符串
 * - path:    目录路径
 * - file:    文件路径
 * - none:    'global'
 */
export function approvalScopeKey(spec: ToolSpec, args: Record<string, unknown>): string {
  switch (spec.approvalScope) {
    case 'command': {
      const c = typeof args.command === 'string' ? args.command.trim() : ''
      return c || 'global'
    }
    case 'path': {
      const p = typeof args.path === 'string' ? args.path : ''
      return p || 'global'
    }
    case 'file': {
      const f = typeof args.path === 'string' || typeof args.file_path === 'string'
        ? ((args.path ?? args.file_path) as string)
        : ''
      return f || 'global'
    }
    default:
      return 'global'
  }
}

// ---------------------------------------------------------------------------
// exec_command 命令风险分类
// ---------------------------------------------------------------------------

/** 直接判为 critical 的命令模式 */
const CRITICAL_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/, // rm -rf / rm -fr
  /\brm\s+--recursive\b/,
  />\s*\/dev\//,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^\n]*\bof=/,
  /\bshred\b/,
  /\bwipefs\b/,
  /\bformat\s+[a-z]:/i,
  /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // fork bomb
  /\bgit\s+push\s+(-[a-z]+\s+)*--force\b/,
  /\bgit\s+push\b[^\n]*\s-f\b/,
  /\bkill\s+(-\d+\s+)*1\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\bpoweroff\b/,
  /\bcrontab\b/,
  /\bchmod\s+-R\b/,
  /\bchown\s+-R\b/,
]

/** 判为 high 的命令模式（修改类/安装类） */
const HIGH_PATTERNS: RegExp[] = [
  /\bsudo\b/,
  /\bapt(-get)?\s+(install|remove|purge)\b/,
  /\bnpm\s+(install|i|add)\b/,
  /\bpip\s+(install|uninstall)\b/,
  /\bcargo\s+(install|remove)\b/,
  /\bbrew\s+(install|uninstall)\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bmv\s+/,
  /\brmdir\s+/,
  /\bunlink\s+/,
  /\btruncate\b/,
  /\bcrontab\b/,
]

/** medium 命令模式（读取外部/网络） */
const MEDIUM_PATTERNS: RegExp[] = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bgit\s+(clone|pull|fetch)\b/,
  /\bnpm\s+(run|exec|npx|test|start|build)\b/,
  /\bgit\s+(commit|add|branch|checkout)\b/,
]

/** 命令风险分类 */
export function classifyCommand(cmd: string): DangerLevel {
  const c = cmd.trim()
  if (!c) return 'low'
  if (CRITICAL_PATTERNS.some((re) => re.test(c))) return 'critical'
  if (HIGH_PATTERNS.some((re) => re.test(c))) return 'high'
  if (MEDIUM_PATTERNS.some((re) => re.test(c))) return 'medium'
  return 'low'
}

/** 敏感路径（写入需额外提示） */
export function isSensitivePath(p: string): boolean {
  if (!p) return false
  const norm = p.replace(/\\/g, '/')
  return (
    norm.includes('/.git/') ||
    norm.endsWith('/.git') ||
    /^\/(etc|usr|bin|sbin|boot|dev|sys|proc)\//.test(norm) ||
    /^(\.git|\.dev-assistant-store)(\/|$)/.test(norm) ||
    norm.includes('id_rsa') ||
    norm.includes('.ssh/')
  )
}
