import { describe, expect, it, vi } from 'vitest'
import { classifyCommand, evaluateTool, approvalScopeKey, isSensitivePath } from '../../src/security/policy.js'
import { ApprovalManager } from '../../src/security/approval.js'
import type { ToolSpec } from '../../src/tools/spec.js'

/**
 * 安全策略 + 审批管理器测试。
 */

function spec(name: string, overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name,
    description: 'test',
    parameters: { type: 'object' },
    dangerLevel: 'low',
    ...overrides,
  }
}

describe('classifyCommand', () => {
  it('普通命令 → low', () => {
    expect(classifyCommand('ls -la')).toBe('low')
    expect(classifyCommand('cat file.txt')).toBe('low')
    expect(classifyCommand('')).toBe('low')
  })

  it('网络/读取类 → medium', () => {
    expect(classifyCommand('curl https://example.com')).toBe('medium')
    expect(classifyCommand('git clone https://x/y.git')).toBe('medium')
    expect(classifyCommand('npm test')).toBe('medium')
  })

  it('安装/修改类 → high', () => {
    expect(classifyCommand('npm install lodash')).toBe('high')
    expect(classifyCommand('sudo apt-get update')).toBe('high')
    expect(classifyCommand('git push origin main')).toBe('high')
    expect(classifyCommand('git reset --hard HEAD~1')).toBe('high')
  })

  it('破坏性命令 → critical', () => {
    expect(classifyCommand('rm -rf /')).toBe('critical')
    expect(classifyCommand('rm -rf node_modules')).toBe('critical')
    expect(classifyCommand('git push --force origin main')).toBe('critical')
    expect(classifyCommand('dd if=/dev/zero of=/dev/sda')).toBe('critical')
    expect(classifyCommand('shutdown -h now')).toBe('critical')
    expect(classifyCommand('chmod -R 777 /')).toBe('critical')
  })
})

describe('evaluateTool', () => {
  it('low 工具 → auto 审批', () => {
    const ev = evaluateTool(spec('read_file'), {})
    expect(ev.dangerLevel).toBe('low')
    expect(ev.approvalRequirement?.approvalType).toBe('auto')
    expect(ev.approvalRequirement?.requiresUserConfirmation).toBe(false)
  })

  it('high 工具（write_file）→ session 审批', () => {
    const ev = evaluateTool(spec('write_file', { dangerLevel: 'high', approvalType: 'session', approvalScope: 'file' }), {})
    expect(ev.approvalRequirement?.approvalType).toBe('session')
    expect(ev.approvalRequirement?.requiresUserConfirmation).toBe(true)
    expect(ev.approvalRequirement?.validitySeconds).toBe(3600)
  })

  it('critical 工具（exec_command）→ one-time 审批', () => {
    const ev = evaluateTool(spec('exec_command', { dangerLevel: 'critical', approvalType: 'one-time', approvalScope: 'command' }), {})
    expect(ev.approvalRequirement?.approvalType).toBe('one-time')
    expect(ev.approvalRequirement?.requiresUserConfirmation).toBe(true)
  })

  it('exec_command 动态升级（low → critical）', () => {
    const s = spec('exec_command', { dangerLevel: 'low', approvalType: 'one-time', approvalScope: 'command' })
    const ev = evaluateTool(s, { command: 'rm -rf /' })
    expect(ev.dangerLevel).toBe('critical')
    expect(ev.reasons.some((r) => r.includes('命令风险'))).toBe(true)
  })

  it('exec_command 普通命令保持 low', () => {
    const s = spec('exec_command', { dangerLevel: 'low' })
    const ev = evaluateTool(s, { command: 'ls' })
    expect(ev.dangerLevel).toBe('low')
  })
})

describe('isSensitivePath', () => {
  it('敏感路径识别', () => {
    expect(isSensitivePath('.git/config')).toBe(true)
    expect(isSensitivePath('/etc/passwd')).toBe(true)
    expect(isSensitivePath('~/.ssh/id_rsa')).toBe(true)
    expect(isSensitivePath('.dev-assistant-store/session_x.jsonl')).toBe(true)
  })
  it('普通路径不敏感', () => {
    expect(isSensitivePath('src/main.ts')).toBe(false)
    expect(isSensitivePath('')).toBe(false)
  })
})

describe('approvalScopeKey', () => {
  it('command scope 取命令', () => {
    const s = spec('exec_command', { approvalScope: 'command' })
    expect(approvalScopeKey(s, { command: 'ls -la' })).toBe('ls -la')
  })
  it('file scope 取路径', () => {
    const s = spec('write_file', { approvalScope: 'file' })
    expect(approvalScopeKey(s, { path: 'a.txt' })).toBe('a.txt')
    expect(approvalScopeKey(s, { file_path: 'b.txt' })).toBe('b.txt')
  })
  it('none scope → global', () => {
    const s = spec('x')
    expect(approvalScopeKey(s, {})).toBe('global')
  })
})

describe('ApprovalManager', () => {
  it('auto 要求直接通过', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const m = new ApprovalManager(confirm)
    const ok = await m.check(
      { approvalType: 'auto', dangerThreshold: 'low', requiresUserConfirmation: false, validitySeconds: 0, scope: 'none' },
      'global',
    )
    expect(ok).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('one-time 每次确认', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const m = new ApprovalManager(confirm)
    const req = { approvalType: 'one-time' as const, dangerThreshold: 'critical' as const, requiresUserConfirmation: true, validitySeconds: 0, scope: 'command' as const }
    await m.check(req, 'ls')
    await m.check(req, 'ls')
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('session 级有效期内只确认一次', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const m = new ApprovalManager(confirm)
    const req = { approvalType: 'session' as const, dangerThreshold: 'high' as const, requiresUserConfirmation: true, validitySeconds: 3600, scope: 'file' as const }
    await m.check(req, 'a.txt')
    await m.check(req, 'a.txt')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(m.activeCount()).toBe(1)
  })

  it('session 级不同 scope 分别确认', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const m = new ApprovalManager(confirm)
    const req = { approvalType: 'session' as const, dangerThreshold: 'high' as const, requiresUserConfirmation: true, validitySeconds: 3600, scope: 'file' as const }
    await m.check(req, 'a.txt')
    await m.check(req, 'b.txt')
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('用户拒绝 → false', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const m = new ApprovalManager(confirm)
    const req = { approvalType: 'one-time' as const, dangerThreshold: 'critical' as const, requiresUserConfirmation: true, validitySeconds: 0, scope: 'command' as const }
    await expect(m.check(req, 'rm -rf /')).resolves.toBe(false)
  })

  it('确认过程抛错 → 安全拒绝', async () => {
    const confirm = vi.fn().mockRejectedValue(new Error('io error'))
    const m = new ApprovalManager(confirm)
    const req = { approvalType: 'one-time' as const, dangerThreshold: 'critical' as const, requiresUserConfirmation: true, validitySeconds: 0, scope: 'command' as const }
    await expect(m.check(req, 'x')).resolves.toBe(false)
  })

  it('setDisabled 全部放行（不调确认）', async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const m = new ApprovalManager(confirm)
    m.setDisabled(true)
    const req = { approvalType: 'one-time' as const, dangerThreshold: 'critical' as const, requiresUserConfirmation: true, validitySeconds: 0, scope: 'command' as const }
    await expect(m.check(req, 'rm -rf /')).resolves.toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('有效期过后重新确认', async () => {
    let now = 1_000_000
    const realNow = Date.now
    Date.now = () => now
    try {
      const confirm = vi.fn().mockResolvedValue(true)
      const m = new ApprovalManager(confirm)
      const req = { approvalType: 'session' as const, dangerThreshold: 'high' as const, requiresUserConfirmation: true, validitySeconds: 1, scope: 'file' as const }
      await m.check(req, 'a.txt')
      now += 2000 // 超过有效期
      await m.check(req, 'a.txt')
      expect(confirm).toHaveBeenCalledTimes(2)
    } finally {
      Date.now = realNow
    }
  })
})
