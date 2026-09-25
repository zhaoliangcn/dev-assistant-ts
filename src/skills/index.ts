import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { log } from '../utils/logger.js'

/**
 * 技能加载（Phase 3：读取已安装技能并注入系统提示词）。
 *
 * 目录约定（与 Rust 版一致）：
 *   <workingDir>/.dev-assistant-skills/<skill-name>/
 *     └── SKILL.md          ← 必需：YAML frontmatter（name/description）+ 正文
 *
 * frontmatter 示例：
 *   ---
 *   name: git-workflow
 *   description: 团队 git 提交与分支规范
 *   ---
 *   （正文：技能指令，注入系统提示词"可用技能"段，LLM 按需遵循）
 *
 * Phase 5 由 skills/installer.ts 负责 Git 克隆安装；本模块只负责加载。
 */

const SKILLS_DIR = '.dev-assistant-skills'
const SKILL_FILE = 'SKILL.md'
/** 单个技能注入系统提示词的长度上限（防止撑爆上下文） */
const MAX_SKILL_PROMPT_CHARS = 4_000

export interface Skill {
  name: string
  description: string
  /** 技能正文（frontmatter 之后的 Markdown） */
  content: string
  /** 技能目录绝对路径 */
  dir: string
}

/** 加载目录下全部已安装技能 */
export async function loadSkills(workingDir: string): Promise<Skill[]> {
  const skillsRoot = path.resolve(workingDir, SKILLS_DIR)
  let entries: string[]
  try {
    entries = await readdir(skillsRoot)
  } catch {
    return [] // 技能目录不存在
  }

  const skills: Skill[] = []
  for (const name of entries.sort()) {
    const skillDir = path.join(skillsRoot, name)
    const file = path.join(skillDir, SKILL_FILE)
    try {
      const text = await readFile(file, 'utf8')
      const skill = parseSkill(name, text, skillDir)
      if (skill) skills.push(skill)
      else log.warn(`技能 ${name} 的 SKILL.md 缺少 frontmatter name/description，已跳过`)
    } catch {
      // 无 SKILL.md 的目录/子目录，忽略
    }
  }
  log.debug('技能加载', { count: skills.length, names: skills.map((s) => s.name) })
  return skills
}

/** 解析 SKILL.md（frontmatter + 正文） */
export function parseSkill(defaultName: string, text: string, dir: string): Skill | undefined {
  const fm = parseFrontmatter(text)
  if (!fm) return undefined
  const name = (fm.name ?? defaultName).trim()
  const description = (fm.description ?? '').trim()
  if (!name || !description) return undefined
  return { name, description, content: fm.body.trim(), dir }
}

/** 解析简单 YAML frontmatter（仅支持 `key: value` 单行，够用且不引入 yaml 依赖） */
function parseFrontmatter(text: string): { name?: string; description?: string; body: string } | undefined {
  // 容忍 BOM
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m || m[1] === undefined) return undefined
  const fmRaw = m[1]
  const body = m[2] ?? ''
  const result: { name?: string; description?: string; body: string } = { body }
  for (const line of fmRaw.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]!.toLowerCase()
    let value = kv[2]!.trim()
    // 去引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key === 'name') result.name = value
    else if (key === 'description') result.description = value
  }
  return result
}

/** 渲染技能注入段（注入系统提示词；无技能返回 undefined） */
export function skillsToPromptSection(skills: Skill[]): string | undefined {
  if (skills.length === 0) return undefined
  const blocks = skills.map((s) => {
    const content = s.content.length > MAX_SKILL_PROMPT_CHARS ? `${s.content.slice(0, MAX_SKILL_PROMPT_CHARS)}\n…（技能内容过长已截断）` : s.content
    return `### ${s.name}\n${s.description}\n\n${content}`
  })
  return `以下技能已安装，当任务匹配技能描述时遵循其指令：\n\n${blocks.join('\n\n')}`
}

/** 技能摘要（供 prompt.ts 的 skills 字段使用：只列 name+description） */
export function skillsToSummary(skills: Skill[]): Array<{ name: string; description: string }> {
  return skills.map((s) => ({ name: s.name, description: s.description }))
}
