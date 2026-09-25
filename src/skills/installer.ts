import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadSkills, type Skill } from './index.js'
import { log } from '../utils/logger.js'

const execFileAsync = promisify(execFile)

/**
 * 技能安装器（Phase 5，对齐设计文档 skills/installer.ts + 13.2 skill 子命令）。
 *
 * 安装约定：Git 仓库根目录或某子目录含 SKILL.md（YAML frontmatter）。
 * - installSkillFromGit：克隆到 <workingDir>/.dev-assistant-skills/<name>/
 * - previewSkillFromGit：克隆到临时目录，解析 SKILL.md 后返回（不落地）
 *
 * 安全：git 克隆用 args 数组（无 shell 注入面）；克隆后校验 SKILL.md 存在。
 */

export interface SkillPreview {
  name: string
  description: string
  content: string
  /** SKILL.md 在仓库中的相对路径 */
  path: string
}

/** 从 Git 仓库安装技能到 workingDir/.dev-assistant-skills/<name>/ */
export async function installSkillFromGit(
  workingDir: string,
  url: string,
  branch?: string,
): Promise<Skill> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'dev-assistant-skill-'))
  try {
    await gitClone(url, tmp, branch)
    const found = await findSkillMd(tmp)
    if (!found) throw new Error('仓库中未找到 SKILL.md')

    // 技能名：SKILL.md frontmatter 优先，否则用仓库目录名
    const { readFile } = await import('node:fs/promises')
    const { parseSkill } = await import('./index.js')
    const sourceDir = path.dirname(found)
    const text = await readFile(found, 'utf8')
    const fallbackName = path.basename(found === path.join(tmp, 'SKILL.md') ? tmp : sourceDir)
    const skill = parseSkill(fallbackName, text, sourceDir)
    if (!skill) throw new Error('SKILL.md 缺少合法 frontmatter（name/description）')

    const target = path.resolve(workingDir, '.dev-assistant-skills', skill.name)
    const { access } = await import('node:fs/promises')
    try {
      await access(target)
      throw new Error(`技能 ${skill.name} 已存在（先 skill remove 再安装）`)
    } catch (e) {
      if (e instanceof Error && e.message.includes('已存在')) throw e
    }

    // 移动技能目录（含 SKILL.md 所在子树；排除 .git 等隐藏元数据）
    await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(target), { recursive: true }))
    await import('node:fs/promises').then((fs) =>
      fs.cp(sourceDir, target, {
        recursive: true,
        filter: (src) => !path.basename(src).startsWith('.git'),
      }),
    )

    const installed = (await loadSkills(workingDir)).find((s) => s.name === skill.name)
    if (!installed) throw new Error('安装后未找到技能（SKILL.md 可能损坏）')
    log.info('技能安装完成', { name: installed.name, url })
    return installed
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 预览技能（克隆到临时目录，不落地） */
export async function previewSkillFromGit(url: string, branch?: string): Promise<SkillPreview> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'dev-assistant-skill-preview-'))
  try {
    await gitClone(url, tmp, branch)
    const found = await findSkillMd(tmp)
    if (!found) throw new Error('仓库中未找到 SKILL.md')
    const { readFile } = await import('node:fs/promises')
    const { parseSkill } = await import('./index.js')
    const sourceDir = path.dirname(found)
    const skill = parseSkill(path.basename(tmp), await readFile(found, 'utf8'), sourceDir)
    if (!skill) throw new Error('SKILL.md 缺少合法 frontmatter（name/description）')
    return {
      name: skill.name,
      description: skill.description,
      content: skill.content.slice(0, 2000),
      path: path.relative(tmp, found),
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 克隆仓库（args 数组，防注入） */
async function gitClone(url: string, dest: string, branch?: string): Promise<void> {
  const args = ['clone', '--depth', '1']
  if (branch) args.push('--branch', branch)
  args.push(url, dest)
  try {
    await execFileAsync('git', args, { timeout: 60_000 })
  } catch (e) {
    const detail = e instanceof Error ? e.message.split('\n').slice(-3).join(' ') : String(e)
    throw new Error(`git 克隆失败: ${detail}`)
  }
}

/** 在目录树中查找 SKILL.md（深度 ≤ 2，优先根目录） */
async function findSkillMd(root: string): Promise<string | undefined> {
  const candidates: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 2) return
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const e of entries) {
      if (e.startsWith('.')) continue
      const full = path.join(dir, e)
      const st = await stat(full).catch(() => undefined)
      if (!st) continue
      if (st.isFile() && e === 'SKILL.md') candidates.push(full)
      else if (st.isDirectory()) await walk(full, depth + 1)
    }
  }
  await walk(root, 0)
  // 根目录优先
  candidates.sort((a, b) => path.dirname(a).length - path.dirname(b).length)
  return candidates[0]
}
