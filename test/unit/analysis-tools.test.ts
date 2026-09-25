import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AnalysisStore, analysisStore } from '../../src/tools/analysis/analysis-store.js'
import { analyzeCodebaseHandler, analyzeCodebaseSpec } from '../../src/tools/analysis/analyze-codebase.js'
import { recordAnalysisHandler, recordAnalysisSpec } from '../../src/tools/analysis/record-analysis.js'
import { getAnalysisSummaryHandler, getAnalysisSummarySpec } from '../../src/tools/analysis/get-analysis-summary.js'
import { finishAnalysisHandler, finishAnalysisSpec } from '../../src/tools/analysis/finish-analysis.js'
import { ReadCache } from '../../src/tools/cache.js'

/**
 * Phase 4 分析工具测试：AnalysisStore 状态机 + 4 个 analysis 工具。
 * 每个用例用独立子目录隔离（AnalysisStore 有进程内单例缓存，按文件路径 key）。
 */

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dev-assistant-analysis-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function sub(name: string): Promise<string> {
  const p = path.join(dir, name)
  await (await import('node:fs/promises')).mkdir(p, { recursive: true })
  return p
}

function toolCtx(workingDir: string) {
  return {
    workingDir,
    cache: new ReadCache(),
    sessionId: 'sess-analysis-test',
  }
}

describe('AnalysisStore 状态机', () => {
  it('start 开启 analyzing 会话并落盘', async () => {
    const wd = await sub('case-1')
    const store = new AnalysisStore(wd)
    const session = await store.start('src/llm')
    expect(session.status).toBe('analyzing')
    expect(session.target).toBe('src/llm')

    // 新实例从磁盘恢复
    const store2 = analysisStore(wd)
    const reloaded = await store2.current()
    expect(reloaded!.id).toBe(session.id)
    expect(reloaded!.status).toBe('analyzing')
  })

  it('重复 start 复用进行中会话', async () => {
    const wd = await sub('case-1')
    const store = analysisStore(wd)
    const again = await store.start('src/tools')
    const cur = (await store.current())!
    expect(again.id).toBe(cur.id)
    expect(again.target).toBe('src/tools') // target 更新
  })

  it('record 追加发现（限制长度/上限）', async () => {
    const wd = await sub('case-2')
    const store = analysisStore(wd)
    await store.start('整个仓库')
    const s1 = await store.record('架构', '多 provider 故障转移')
    expect(s1.records.length).toBe(1)
    const s2 = await store.record('风险', '长'.repeat(5_000))
    expect(s2.records.length).toBe(2)
    expect(s2.records[1]!.content.length).toBe(4_000)
  })

  it('无会话时 record 抛错', async () => {
    const wd = await sub('case-3')
    const store = analysisStore(wd)
    await expect(store.record('t', 'c')).rejects.toThrow('analyze_codebase')
  })

  it('finish 完成会话；完成后 record 抛错', async () => {
    const wd = await sub('case-4')
    const store = analysisStore(wd)
    await store.start('target-x')
    await store.record('发现A', '内容A')
    const done = await store.finish()
    expect(done.status).toBe('completed')
    await expect(store.record('发现B', '内容B')).rejects.toThrow('已')
  })

  it('重启后 analyzing 会话标记 abandoned', async () => {
    const wd = await sub('case-5')
    const store = analysisStore(wd)
    await store.start('target-y')

    // 模拟进程重启：重置模块注册表，使 AnalysisStore 的模块级单例缓存清空
    vi.resetModules()
    const freshModule = await import('../../src/tools/analysis/analysis-store.js')
    const fresh = new freshModule.AnalysisStore(wd)
    const reloaded = await fresh.current()
    expect(reloaded).toBeDefined()
    expect(reloaded!.status).toBe('abandoned')

    // 中断后不能再记录
    await expect(fresh.record('t', 'c')).rejects.toThrow()
  })
})

describe('analysis 工具 specs', () => {
  it('命名与危险级别', () => {
    expect(analyzeCodebaseSpec.name).toBe('analyze_codebase')
    expect(analyzeCodebaseSpec.dangerLevel).toBe('low')
    expect(recordAnalysisSpec.name).toBe('record_analysis')
    expect(recordAnalysisSpec.dangerLevel).toBe('low')
    expect(getAnalysisSummarySpec.name).toBe('get_analysis_summary')
    expect(getAnalysisSummarySpec.dangerLevel).toBe('low')
    expect(finishAnalysisSpec.name).toBe('finish_analysis')
    expect(finishAnalysisSpec.dangerLevel).toBe('low')
  })
})

describe('analysis 工具 handlers', () => {
  it('完整工作流：analyze → record → summary → finish', async () => {
    const wd = await sub('case-6')

    const r1 = await analyzeCodebaseHandler({ arguments: { target: 'src/llm' } }, toolCtx(wd))
    expect(r1.success).toBe(true)
    expect(r1.content).toContain('分析会话已开启')

    const r2 = await recordAnalysisHandler(
      { arguments: { title: '多 provider 故障转移', content: 'client.ts 按序切换 provider' } },
      toolCtx(wd),
    )
    expect(r2.success).toBe(true)
    expect(r2.content).toContain('已记录第 1 条')

    const r3 = await getAnalysisSummaryHandler({ arguments: { recent: 2 } }, toolCtx(wd))
    expect(r3.success).toBe(true)
    expect(r3.content).toContain('多 provider 故障转移')
    expect(r3.content).toContain('发现条数: 1')

    const r4 = await finishAnalysisHandler(
      { arguments: { conclusion: 'LLM 层设计稳健' } },
      toolCtx(wd),
    )
    expect(r4.success).toBe(true)
    expect(r4.content).toContain('分析完成')
    expect(r4.content).toContain('多 provider 故障转移')
    expect(r4.content).toContain('结论: LLM 层设计稳健')
  })

  it('analyze_codebase 缺 target 报错', async () => {
    const wd = await sub('case-7')
    const r = await analyzeCodebaseHandler({ arguments: {} }, toolCtx(wd))
    expect(r.success).toBe(false)
    expect(r.content).toContain('target')
  })

  it('record_analysis 缺参数报错', async () => {
    const wd = await sub('case-8')
    const r = await recordAnalysisHandler({ arguments: {} }, toolCtx(wd))
    expect(r.success).toBe(false)
  })

  it('get_analysis_summary 无会话时提示', async () => {
    const wd = await sub('case-9')
    const r = await getAnalysisSummaryHandler({ arguments: {} }, toolCtx(wd))
    expect(r.success).toBe(true)
    expect(r.content).toContain('没有分析会话')
  })

  it('finish_analysis 无发现时拒绝收尾', async () => {
    const wd = await sub('case-10')
    await analyzeCodebaseHandler({ arguments: { target: '空仓库' } }, toolCtx(wd))
    const r = await finishAnalysisHandler({ arguments: {} }, toolCtx(wd))
    expect(r.success).toBe(false)
    expect(r.content).toContain('没有任何发现')
  })

  it('finish_analysis 已完成后幂等返回', async () => {
    const wd = await sub('case-6')
    const r = await finishAnalysisHandler({ arguments: {} }, toolCtx(wd))
    expect(r.success).toBe(true)
    expect(r.content).toContain('已完成')
  })

  it('finish_analysis 无会话时报错', async () => {
    const wd = await sub('case-11')
    const r = await finishAnalysisHandler({ arguments: {} }, toolCtx(wd))
    expect(r.success).toBe(false)
  })
})
