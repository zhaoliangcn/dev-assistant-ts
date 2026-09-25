import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'
import type { ModelsConfig, ProviderConfig, ProviderType, ReasoningEffort } from '../llm/models.js'
import { AppError } from '../utils/error.js'

/**
 * 模型配置加载。
 * 对齐 dev-assistant-rs 的 `.dev-assistant-models.toml` 格式：
 *
 *   [[models]]
 *   name = "gpt"
 *   provider = "openai"
 *   api_url = "https://api.openai.com/v1"
 *   api_key = "${OPENAI_API_KEY}"
 *   model = "gpt-4o"
 *   temperature = 0.2
 *   max_output_tokens = 8192
 *   reasoning_effort = "medium"
 *
 * 特性：
 * - `${VAR}` 占位符从 process.env 解析（仅用于 api_key 字段）
 * - 字段缺省合理默认值
 * - 校验 provider 类型与必填字段，错误统一为 AppError.Config
 */

export const DEFAULT_CONFIG_NAME = '.dev-assistant-models.toml'

const VALID_PROVIDERS: ProviderType[] = ['openai', 'openai-compatible', 'anthropic', 'ollama']
const VALID_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'none', 'max', 'xhigh']

/** 解析字符串中的 `${VAR}` 占位符（未设置的变量解析为空串并记 warn） */
export function resolveEnvVars(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = env[name]
    return v ?? ''
  })
}

/** 从 TOML 文本加载配置 */
export function parseModelsConfig(tomlText: string, env: NodeJS.ProcessEnv = process.env): ModelsConfig {
  let raw: unknown
  try {
    raw = parse(tomlText)
  } catch (e) {
    throw AppError.Config(`TOML 解析失败: ${e instanceof Error ? e.message : String(e)}`)
  }
  const root = raw as Record<string, unknown>
  const arr = root.models
  if (!Array.isArray(arr)) {
    throw AppError.Config('配置缺少 [[models]] 数组')
  }
  const models = arr.map((item, i) => parseProviderConfig(item, i, env))
  return { models }
}

function parseProviderConfig(raw: unknown, index: number, env: NodeJS.ProcessEnv): ProviderConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw AppError.Config(`[[models]] 第 ${index + 1} 条不是表（table）`)
  }
  const t = raw as Record<string, unknown>

  const name = str(t.name, `models[${index}].name`)
  const providerRaw = str(t.provider, `models[${index}].provider`)
  if (!VALID_PROVIDERS.includes(providerRaw as ProviderType)) {
    throw AppError.Config(
      `models[${index}].provider 取值非法: ${providerRaw}（可选: ${VALID_PROVIDERS.join(', ')}）`,
    )
  }
  const provider = providerRaw as ProviderType

  // api_url：其余 provider 必填；ollama 缺省本地地址
  const api_url = t.api_url
  let apiUrl: string
  if (api_url !== undefined) {
    apiUrl = str(api_url, `models[${index}].api_url`)
  } else if (provider === 'ollama') {
    apiUrl = 'http://127.0.0.1:11434/v1'
  } else {
    throw AppError.Config(`配置缺少必填字段 models[${index}].api_url（非空字符串）`)
  }
  const model = str(t.model, `models[${index}].model`)

  const api_key = t.api_key
  const apiKey = api_key !== undefined ? resolveEnvVars(String(api_key), env) : undefined

  let temperature: number | undefined
  if (t.temperature !== undefined) {
    temperature = num(t.temperature, `models[${index}].temperature`)
    if (temperature < 0 || temperature > 2) {
      throw AppError.Config(`models[${index}].temperature 超出 [0, 2] 范围: ${temperature}`)
    }
  }

  let maxOutputTokens: number | undefined
  if (t.max_output_tokens !== undefined) {
    maxOutputTokens = num(t.max_output_tokens, `models[${index}].max_output_tokens`)
  }

  let reasoningEffort: ReasoningEffort | undefined
  if (t.reasoning_effort !== undefined) {
    const eff = String(t.reasoning_effort)
    if (!VALID_EFFORTS.includes(eff as ReasoningEffort)) {
      throw AppError.Config(
        `models[${index}].reasoning_effort 取值非法: ${eff}（可选: ${VALID_EFFORTS.join(', ')}）`,
      )
    }
    reasoningEffort = eff as ReasoningEffort
  }

  return {
    name,
    provider,
    apiUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
    model,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw AppError.Config(`配置缺少必填字段 ${field}（非空字符串）`)
  }
  return v.trim()
}

function num(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw AppError.Config(`配置字段 ${field} 必须是数字，实际: ${String(v)}`)
  }
  return v
}

/**
 * 从文件加载配置。
 * @param configPath 显式路径；为 null 时按工作目录找默认文件名
 * @returns 解析后的配置；文件不存在时返回 { models: [] }
 */
export async function loadModelsConfig(
  workingDir: string,
  configPath: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelsConfig> {
  const file = configPath ? path.resolve(configPath) : path.join(workingDir, DEFAULT_CONFIG_NAME)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { models: [] }
    }
    throw AppError.Config(`无法读取配置文件 ${file}: ${e instanceof Error ? e.message : String(e)}`)
  }
  return parseModelsConfig(text, env)
}

/**
 * 应用 CLI 覆盖：--provider / --model 在第一个匹配的 provider 上生效。
 * 若指定了 provider 但无匹配条目，则新建一条（apiUrl 用默认值）。
 */
export function applyOverrides(
  config: ModelsConfig,
  overrides: { provider?: string; model?: string },
): ModelsConfig {
  if (!overrides.provider && !overrides.model) return config

  const models = [...config.models]
  if (overrides.provider) {
    const idx = models.findIndex((m) => m.name === overrides.provider || m.provider === overrides.provider)
    if (idx === -1) {
      // 新建条目
      const name = overrides.provider
      const providerType = VALID_PROVIDERS.includes(overrides.provider as ProviderType)
        ? (overrides.provider as ProviderType)
        : 'openai-compatible'
      const defaults: Record<string, string> = {
        openai: 'https://api.openai.com/v1',
        'openai-compatible': 'http://127.0.0.1:11434/v1',
        ollama: 'http://127.0.0.1:11434/v1',
        anthropic: 'https://api.anthropic.com/v1',
      }
      models.push({
        name,
        provider: providerType,
        apiUrl: defaults[providerType] ?? 'https://api.openai.com/v1',
        model: overrides.model ?? 'gpt-4o',
      })
    } else if (overrides.model) {
      const existing = models[idx]
      if (existing) models[idx] = { ...existing, model: overrides.model }
    }
  } else if (overrides.model) {
    const first = models[0]
    if (first) models[0] = { ...first, model: overrides.model }
  }
  return { models }
}
