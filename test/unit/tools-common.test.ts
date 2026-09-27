import { describe, expect, it } from 'vitest'
import {
  argBoolean,
  argNumber,
  argObject,
  argString,
  argStringArray,
  lenientParseArgs,
} from '../../src/tools/common.js'

/** lenientParseArgs 兜底路径 + 宽容取值函数。 */

describe('lenientParseArgs', () => {
  it('标准 JSON 对象直接解析，无 warning', () => {
    const { args, warning } = lenientParseArgs('{"target": "src/llm"}')
    expect(args).toEqual({ target: 'src/llm' })
    expect(warning).toBeUndefined()
  })

  it('空参数返回空对象', () => {
    expect(lenientParseArgs('')).toEqual({ args: {} })
    expect(lenientParseArgs('   \n')).toEqual({ args: {} })
  })

  it('非对象（数字/数组）给出警告且不误用', () => {
    const num = lenientParseArgs('42')
    expect(num.args).toEqual({})
    expect(num.warning).toContain('工具参数应为 JSON 对象')

    const arr = lenientParseArgs('[1, 2]')
    expect(arr.args).toEqual({})
    expect(arr.warning).toContain('数组')
  })

  it('markdown 围栏自动清理', () => {
    const { args, warning } = lenientParseArgs('```json\n{"target": "src"}\n```')
    expect(args).toEqual({ target: 'src' })
    expect(warning).toContain('markdown 围栏')
  })

  it('裸键值对（缺外层花括号，键带引号）自动补全 —— analyze_codebase 实际踩中 case', () => {
    const { args, warning } = lenientParseArgs('"target": "整个仓库"')
    expect(args).toEqual({ target: '整个仓库' })
    expect(warning).toContain('外层花括号')
  })

  it('多行裸键值对自动补全', () => {
    const { args } = lenientParseArgs('"target": "src/llm",\n"limit": 3')
    expect(args).toEqual({ target: 'src/llm', limit: 3 })
  })

  it('键未加引号时补引号修复', () => {
    const { args, warning } = lenientParseArgs('target: "整个仓库"')
    expect(args).toEqual({ target: '整个仓库' })
    expect(warning).toContain('引号')
  })

  it('彻底非法的输入返回解析失败警告', () => {
    const { args, warning } = lenientParseArgs('随便什么不是参数的东西')
    expect(args).toEqual({})
    expect(warning).toContain('工具参数 JSON 解析失败')
  })

  it('字符串值内的冒号/逗号不会被键引号修复误伤', () => {
    // "note" 的值含 ", world: foo"——兜底②直接成功，不会走到键引号替换
    const { args, warning } = lenientParseArgs('"note": "hello, world: foo"')
    expect(args).toEqual({ note: 'hello, world: foo' })
    expect(warning).toContain('外层花括号')
  })
})

describe('宽容取值函数', () => {
  it('argString 容忍数字，空串视为缺省', () => {
    expect(argString({ a: 42 }, 'a')).toBe('42')
    expect(argString({ a: '' }, 'a')).toBeUndefined()
    expect(argString({ a: null }, 'a')).toBeUndefined()
  })

  it('argNumber 容忍字符串数字', () => {
    expect(argNumber({ n: '3' }, 'n')).toBe(3)
    expect(argNumber({ n: 'abc' }, 'n')).toBeUndefined()
  })

  it('argBoolean 容忍 true/1/yes 字符串', () => {
    expect(argBoolean({ b: 'yes' }, 'b')).toBe(true)
    expect(argBoolean({ b: 'off' }, 'b')).toBe(false)
    expect(argBoolean({ b: 'maybe' }, 'b')).toBeUndefined()
  })

  it('argStringArray 容忍逗号分隔字符串', () => {
    expect(argStringArray({ arr: 'a, b;c' }, 'arr')).toEqual(['a', 'b', 'c'])
    expect(argStringArray({ arr: 'single' }, 'arr')).toEqual(['single'])
  })

  it('argObject 容忍 JSON 字符串形状的对象参数', () => {
    expect(argObject({ o: '{"x": 1}' }, 'o')).toEqual({ x: 1 })
    expect(argObject({ o: { x: 1 } }, 'o')).toEqual({ x: 1 })
    expect(argObject({ o: 'plain text' }, 'o')).toBe('plain text')
  })
})
