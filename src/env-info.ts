import os from 'node:os'

/**
 * 运行环境信息（对齐设计文档 env-info.ts）。
 *
 * 收集 OS / 架构 / Node 版本 / 终端能力，注入系统提示词让 LLM 感知执行环境
 * （例如知道是 macOS + zsh，生成的 shell 命令更贴近实际）。
 */

export interface EnvInfo {
  platform: string
  arch: string
  osRelease: string
  nodeVersion: string
  shell: string
  /** 是否具备真实终端（影响 UI 降级决策） */
  isTTY: boolean
}

/** 采集当前环境（同步、无 IO 依赖） */
export function collectEnvInfo(): EnvInfo {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: process.version,
    shell: process.env.SHELL ?? '(unknown)',
    isTTY: process.stdout.isTTY === true && process.stdin.isTTY === true,
  }
}

/** 渲染为系统提示词片段（单行，低 token 成本） */
export function envInfoToPromptLine(env: EnvInfo): string {
  return (
    `运行环境: ${env.platform}/${env.arch} (node ${env.nodeVersion}, shell=${env.shell})。` +
    '生成 shell 命令时遵循该平台的惯例与路径分隔符。'
  )
}
