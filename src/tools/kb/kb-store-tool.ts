import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString, argStringArray } from '../common.js'
import { KbStore } from './kb-store.js'
import path from 'node:path'

/**
 * kb_store：存入/覆盖知识库笔记（对齐设计文档 6.5）。
 * 存储：.dev-assistant-kb/<slug>.md（frontmatter + 正文）。
 */

export const kbStoreSpec: ToolSpec = {
  name: 'kb_store',
  description:
    '把一条知识存入项目知识库（Markdown 笔记，存于 .dev-assistant-kb/）。同标题笔记会被覆盖更新。适合记录架构决策、踩坑经验、API 用法等长期有效的知识。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '笔记标题（作为文件名 slug，同标题覆盖）' },
      content: { type: 'string', description: '笔记正文（Markdown）' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签列表（小写，用于 kb_query 过滤）' },
    },
    required: ['title', 'content'],
  },
  dangerLevel: 'low',
}

/** 从 ToolContext 构造 KbStore（供 kb 系列工具复用） */
export function kbStoreFromContext(ctx: { workingDir: string }): KbStore {
  return new KbStore(ctx.workingDir)
}

export const kbStoreHandler: ToolHandler = async (args, ctx) => {
  const title = argString(args.arguments, 'title')
  const content = argString(args.arguments, 'content')
  if (!title) return fail('缺少参数 title（笔记标题）')
  if (!content) return fail('缺少参数 content（笔记正文）')
  const tags = (argStringArray(args.arguments, 'tags') ?? []).filter((t) => typeof t === 'string')

  try {
    const store = kbStoreFromContext(ctx)
    const note = await store.put(title, content, tags)
    return {
      success: true,
      content: `已存入知识库: ${note.title}（id=${note.id}，${note.content.length} 字符）\n路径: ${path.relative(ctx.workingDir, note.file)}\n标签: ${note.tags.length > 0 ? note.tags.join(', ') : '（无）'}`,
      restartRequested: false,
    }
  } catch (e) {
    return fail(`知识库写入失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function fail(message: string) {
  return {
    success: false as const,
    content: message,
    restartRequested: false as const,
    errorCategory: 'permanent' as const,
  }
}
