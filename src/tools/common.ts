/**
 * 宽容参数解析（lenient args parsing）。
 *
 * LLM 生成的 JSON 参数经常"形状不对"：
 * - 应传对象却传了 JSON 字符串
 * - 应传数组却传了逗号分隔字符串
 * - 应传数字却传了数字字符串
 * - 多余的空格 / null
 *
 * 本模块提供一组容错取值函数，避免 Agent 因参数形状问题反复失败。
 */

/** 取字符串参数：容忍 null/undefined/数字；空串返回 undefined */
export function argString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  const s = String(v).trim()
  return s.length > 0 ? s : undefined
}

/** 取数字参数：容忍字符串数字；非法返回 undefined */
export function argNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  return Number.isFinite(n) ? n : undefined
}

/** 取布尔参数：容忍 "true"/"1"/"yes" 字符串 */
export function argBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (s === '' ) return undefined
  if (['true', '1', 'yes', 'on'].includes(s)) return true
  if (['false', '0', 'no', 'off'].includes(s)) return false
  return undefined
}

/** 取数组参数：容忍逗号/分号分隔字符串、单个字符串 */
export function argStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x.length > 0)
  if (typeof v === 'string') {
    return v
      .split(/[,;\n]/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  }
  return [String(v)]
}

/**
 * 取值并尝试 JSON 反序列化（LLM 常把对象参数传成 JSON 字符串）。
 * 已是对象则原样返回；字符串尝试 parse 失败则返回原始字符串。
 */
export function argObject(args: Record<string, unknown>, key: string): Record<string, unknown> | string | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v === 'string') {
    const s = v.trim()
    if (s.startsWith('{')) {
      try {
        const parsed = JSON.parse(s)
        if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
      } catch {
        // 返回原始字符串
      }
    }
    return v
  }
  return String(v)
}

/** 宽松解析工具调用参数 JSON 字符串；失败时返回 {} 并给出诊断 */
export function lenientParseArgs(json: string): { args: Record<string, unknown>; warning?: string } {
  if (!json || !json.trim()) return { args: {} }
  try {
    const parsed = JSON.parse(json)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> }
    }
    return { args: {}, warning: `工具参数应为 JSON 对象，实际为 ${Array.isArray(parsed) ? '数组' : typeof parsed}` }
  } catch (e) {
    // 常见错误：LLM 在 JSON 前后加了多余文本或 markdown 围栏
    const cleaned = json.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try {
      const parsed = JSON.parse(cleaned)
      if (typeof parsed === 'object' && parsed !== null) {
        return {
          args: (Array.isArray(parsed) ? {} : parsed) as Record<string, unknown>,
          warning: '工具参数含 markdown 围栏，已自动清理',
        }
      }
    } catch {
      // 继续
    }
    const msg = e instanceof Error ? e.message : String(e)
    return { args: {}, warning: `工具参数 JSON 解析失败: ${msg}` }
  }
}
