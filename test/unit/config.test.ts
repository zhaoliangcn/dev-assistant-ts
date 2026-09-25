import { describe, expect, it } from 'vitest'
import { parseModelsConfig, resolveEnvVars, applyOverrides } from '../../src/config/index.js'
import { AppError } from '../../src/utils/error.js'

const SAMPLE = `
[[models]]
name = "gpt"
provider = "openai"
api_url = "https://api.openai.com/v1"
api_key = "\${OPENAI_API_KEY}"
model = "gpt-4o"
temperature = 0.2
max_output_tokens = 8192
reasoning_effort = "medium"

[[models]]
name = "ollama"
provider = "ollama"
model = "qwen2.5:14b"
`

describe('resolveEnvVars', () => {
  it('解析 ${VAR} 占位符', () => {
    expect(resolveEnvVars('sk-${FOO}', { FOO: 'abc' } as NodeJS.ProcessEnv)).toBe('sk-abc')
  })
  it('未设置的变量解析为空串', () => {
    expect(resolveEnvVars('sk-${MISSING}', {} as NodeJS.ProcessEnv)).toBe('sk-')
  })
  it('多个占位符', () => {
    expect(resolveEnvVars('${A}-${B}', { A: '1', B: '2' } as NodeJS.ProcessEnv)).toBe('1-2')
  })
  it('无占位符原样返回', () => {
    expect(resolveEnvVars('plain', {} as NodeJS.ProcessEnv)).toBe('plain')
  })
  it('非法变量名不替换', () => {
    expect(resolveEnvVars('${1BAD}', {} as NodeJS.ProcessEnv)).toBe('${1BAD}')
  })
})

describe('parseModelsConfig', () => {
  it('解析完整条目（含环境变量）', () => {
    const cfg = parseModelsConfig(SAMPLE, { OPENAI_API_KEY: 'sk-test-123' } as NodeJS.ProcessEnv)
    expect(cfg.models).toHaveLength(2)
    const [gpt, ollama] = cfg.models
    expect(gpt).toMatchObject({
      name: 'gpt',
      provider: 'openai',
      apiUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-123',
      model: 'gpt-4o',
      temperature: 0.2,
      maxOutputTokens: 8192,
      reasoningEffort: 'medium',
    })
    // ollama 缺省本地地址
    expect(ollama).toMatchObject({
      name: 'ollama',
      provider: 'ollama',
      apiUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:14b',
    })
  })

  it('缺少必填字段 → Config 错误', () => {
    const base = `
[[models]]
name = "x"
provider = "openai"
api_url = "http://x"
model = "m"
`
    for (const missing of ['name', 'provider', 'api_url', 'model']) {
      const broken = base.replace(new RegExp(`^${missing} = [^\\n]*\\n`, 'm'), '')
      expect(() => parseModelsConfig(broken), missing).toThrow(AppError)
    }
  })

  it('非法 provider 类型 → Config 错误', () => {
    expect(() =>
      parseModelsConfig(`
[[models]]
name = "x"
provider = "gemini"
api_url = "http://x"
model = "m"
`),
    ).toThrow(/provider 取值非法/)
  })

  it('temperature 超范围 → Config 错误', () => {
    expect(() =>
      parseModelsConfig(`
[[models]]
name = "x"
provider = "openai"
api_url = "http://x"
model = "m"
temperature = 5
`),
    ).toThrow(/temperature/)
  })

  it('非法 reasoning_effort → Config 错误', () => {
    expect(() =>
      parseModelsConfig(`
[[models]]
name = "x"
provider = "openai"
api_url = "http://x"
model = "m"
reasoning_effort = "turbo"
`),
    ).toThrow(/reasoning_effort/)
  })

  it('缺少 [[models]] → Config 错误', () => {
    expect(() => parseModelsConfig('foo = 1')).toThrow(/\[\[models\]\]/)
  })

  it('TOML 语法错误 → Config 错误', () => {
    expect(() => parseModelsConfig('models = [unclosed')).toThrow(/TOML 解析失败/)
  })
})

describe('applyOverrides', () => {
  const base = () =>
    parseModelsConfig(
      `
[[models]]
name = "gpt"
provider = "openai"
api_url = "https://api.openai.com/v1"
model = "gpt-4o"
`,
    )

  it('无覆盖时原样返回', () => {
    const cfg = base()
    expect(applyOverrides(cfg, {})).toBe(cfg)
  })

  it('--model 覆盖第一个条目的模型', () => {
    const cfg = applyOverrides(base(), { model: 'gpt-4o-mini' })
    expect(cfg.models[0]?.model).toBe('gpt-4o-mini')
  })

  it('--provider 按名称匹配并覆盖 model', () => {
    const cfg = applyOverrides(base(), { provider: 'gpt', model: 'gpt-4.1' })
    expect(cfg.models[0]?.model).toBe('gpt-4.1')
  })

  it('--provider 无匹配时新建条目', () => {
    const cfg = applyOverrides(base(), { provider: 'deepseek' })
    expect(cfg.models).toHaveLength(2)
    const added = cfg.models[1]
    expect(added?.provider).toBe('openai-compatible')
    expect(added?.model).toBe('gpt-4o')
  })

  it('--provider 已知类型映射默认 api_url', () => {
    for (const [name, url] of [
      ['anthropic', 'https://api.anthropic.com/v1'],
      ['ollama', 'http://127.0.0.1:11434/v1'],
    ] as const) {
      const cfg = applyOverrides(base(), { provider: name })
      expect(cfg.models[1]?.apiUrl).toBe(url)
    }
  })
})
