import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadSkills, parseSkill, skillsToPromptSection, skillsToSummary } from '../../src/skills/index.js'

/**
 * Phase 3 技能加载测试：frontmatter 解析、目录扫描、提示词注入段。
 */

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-skills-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('parseSkill', () => {
  it('解析 frontmatter name/description + 正文', () => {
    const skill = parseSkill(
      'fallback',
      '---\nname: git-workflow\ndescription: 团队 git 规范\n---\n\n提交前必须跑 lint。',
      '/tmp/x',
    )
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('git-workflow')
    expect(skill!.description).toBe('团队 git 规范')
    expect(skill!.content).toContain('提交前必须跑 lint')
  })

  it('无 frontmatter 返回 undefined', () => {
    expect(parseSkill('x', '只有正文，没有 frontmatter', '/tmp/x')).toBeUndefined()
  })

  it('缺 description 返回 undefined', () => {
    expect(parseSkill('x', '---\nname: a\n---\n正文', '/tmp/x')).toBeUndefined()
  })

  it('frontmatter 缺 name 时用目录名兜底', () => {
    const skill = parseSkill('my-skill', '---\ndescription: 有描述\n---\n正文', '/tmp/x')
    expect(skill).toBeDefined()
    expect(skill!.name).toBe('my-skill')
  })

  it('引号包裹的值被去除引号', () => {
    const skill = parseSkill('x', '---\nname: "quoted"\ndescription: \'带引号的描述\'\n---\n正文', '/tmp/x')
    expect(skill!.name).toBe('quoted')
    expect(skill!.description).toBe('带引号的描述')
  })

  it('容忍 BOM', () => {
    const skill = parseSkill('x', '\ufeff---\nname: bom\ndescription: d\n---\n正文', '/tmp/x')
    expect(skill!.name).toBe('bom')
  })
})

describe('loadSkills', () => {
  it('技能目录不存在返回空', async () => {
    expect(await loadSkills(dir)).toEqual([])
  })

  it('扫描 .dev-assistant-skills/*/SKILL.md', async () => {
    await mkdir(path.join(dir, '.dev-assistant-skills', 'alpha'), { recursive: true })
    await writeFile(
      path.join(dir, '.dev-assistant-skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: 第一个技能\n---\nalpha 指令',
      'utf8',
    )
    await mkdir(path.join(dir, '.dev-assistant-skills', 'beta'), { recursive: true })
    await writeFile(
      path.join(dir, '.dev-assistant-skills', 'beta', 'SKILL.md'),
      '---\nname: beta\ndescription: 第二个技能\n---\nbeta 指令',
      'utf8',
    )

    const skills = await loadSkills(dir)
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'beta'])
    expect(skills[0]!.content).toBe('alpha 指令')
  })

  it('跳过无 SKILL.md 的目录与无效 frontmatter', async () => {
    await mkdir(path.join(dir, '.dev-assistant-skills', 'empty'), { recursive: true })
    await mkdir(path.join(dir, '.dev-assistant-skills', 'bad'), { recursive: true })
    await writeFile(path.join(dir, '.dev-assistant-skills', 'bad', 'SKILL.md'), '没有 frontmatter', 'utf8')

    const skills = await loadSkills(dir)
    expect(skills.map((s) => s.name)).not.toContain('empty')
    expect(skills.map((s) => s.name)).not.toContain('bad')
  })
})

describe('skillsToPromptSection / skillsToSummary', () => {
  it('无技能返回 undefined', () => {
    expect(skillsToPromptSection([])).toBeUndefined()
  })

  it('有技能渲染 name + description + 正文', () => {
    const section = skillsToPromptSection([
      { name: 'demo', description: '示例技能', content: '做 A 做 B', dir: '/x' },
    ])
    expect(section).toContain('demo')
    expect(section).toContain('示例技能')
    expect(section).toContain('做 A 做 B')
  })

  it('超长正文截断到 4000 字符', () => {
    const section = skillsToPromptSection([
      { name: 'long', description: 'd', content: '长'.repeat(5000), dir: '/x' },
    ])
    expect(section).toContain('过长已截断')
    expect(section!.length).toBeLessThan(4200)
  })

  it('摘要只含 name + description', () => {
    const summary = skillsToSummary([{ name: 'a', description: 'd1', content: 'c', dir: '/x' }])
    expect(summary).toEqual([{ name: 'a', description: 'd1' }])
  })
})
