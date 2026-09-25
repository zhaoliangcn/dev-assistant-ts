import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { installSkillFromGit, previewSkillFromGit, type SkillPreview } from '../../src/skills/installer.js'
import { loadSkills } from '../../src/skills/index.js'
import { collectEnvInfo, envInfoToPromptLine } from '../../src/env-info.js'

/**
 * Phase 5 技能安装器 + env-info 测试。
 *
 * installSkillFromGit / previewSkillFromGit 需要 git 仓库：
 * 本地用 `git init` 造一个含 SKILL.md 的仓库（file:// 克隆），不依赖网络。
 */

let dir: string
let localRepo: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-installer-'))
  localRepo = await makeLocalSkillRepo('test-skill-repo')
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(path.dirname(localRepo), { recursive: true, force: true }).catch(() => undefined)
})

/** 造一个本地 git 仓库（含 SKILL.md） */
async function makeLocalSkillRepo(name: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const repo = path.join(dir, name)
  await mkdir(repo, { recursive: true })
  await writeFile(
    path.join(repo, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: 测试技能（来自本地仓库）\n---\n\n技能正文：做 A 做 B。',
    'utf8',
  )
  await exec('git', ['init', '-q'], { cwd: repo })
  await exec('git', ['add', '.'], { cwd: repo })
  await exec(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init skill'],
    { cwd: repo },
  )
  return repo
}

describe('previewSkillFromGit', () => {
  it('解析本地仓库 SKILL.md（不落盘）', async () => {
    const preview: SkillPreview = await previewSkillFromGit(`file://${localRepo}`)
    expect(preview.name).toBe('demo-skill')
    expect(preview.description).toBe('测试技能（来自本地仓库）')
    expect(preview.content).toContain('做 A 做 B')
    expect(preview.path).toBe('SKILL.md')
  })

  it('无 SKILL.md 的仓库报错', async () => {
    const bare = path.join(dir, 'bare-repo')
    await mkdir(bare, { recursive: true })
    await writeFile(path.join(bare, 'README.md'), 'no skill here')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)
    await exec('git', ['init', '-q'], { cwd: bare })
    await exec('git', ['add', '.'], { cwd: bare })
    await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x'], { cwd: bare })
    await expect(previewSkillFromGit(`file://${bare}`)).rejects.toThrow('SKILL.md')
  })
})

describe('installSkillFromGit', () => {
  it('克隆安装到 .dev-assistant-skills/<name>/（loadSkills 可见）', async () => {
    const working = path.join(dir, 'working-1')
    await mkdir(working, { recursive: true })
    const skill = await installSkillFromGit(working, `file://${localRepo}`)
    expect(skill.name).toBe('demo-skill')
    // 落盘校验
    const installed = await loadSkills(working)
    expect(installed.map((s) => s.name)).toContain('demo-skill')
  })

  it('重复安装报"已存在"', async () => {
    const working = path.join(dir, 'working-1')
    await expect(installSkillFromGit(working, `file://${localRepo}`)).rejects.toThrow('已存在')
  })

  it('非法 URL 报 git 克隆失败', async () => {
    const working = path.join(dir, 'working-2')
    await mkdir(working, { recursive: true })
    await expect(installSkillFromGit(working, 'file:///nonexistent/repo-xyz')).rejects.toThrow('克隆失败')
  })
})

describe('env-info', () => {
  it('collectEnvInfo 字段完整', () => {
    const env = collectEnvInfo()
    expect(env.platform).toBe(process.platform)
    expect(env.arch).toBe(process.arch)
    expect(env.nodeVersion).toBe(process.version)
    expect(typeof env.osRelease).toBe('string')
    expect(typeof env.isTTY).toBe('boolean')
  })

  it('envInfoToPromptLine 含平台与 node 版本', () => {
    const line = envInfoToPromptLine(collectEnvInfo())
    expect(line).toContain(process.platform)
    expect(line).toContain(process.version)
  })
})
