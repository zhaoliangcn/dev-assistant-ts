import type { ToolSpec } from '../spec.js'
import type { ToolHandler } from '../registry.js'
import { argString, argStringArray, argNumber } from '../common.js'
import { KbStore } from './kb-store.js'

/**
 * kb_query：查询知识库（对齐设计文档 6.5）。
 * 关键词打分（词频 × IDF 近似）+ 标签过滤，返回 top N 带正文预览。
 * action=list 时仅列出全部笔记元信息。
 */

const MAX_PREVIEW_CHARS = 800

export const kbQuerySpec: ToolSpec = {
  name: 'kb_query',
  description:
    '查询项目知识库（.dev-assistant-kb/）。传 keywords 按相关性返回 top N 笔记（含正文预览）；tags 可过滤标签；action=list 只列笔记目录。回答"之前记过什么 / 项目有什么约定"类问题前先查这里。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['query', 'list'], description: 'query=关键词查询（默认），list=列出全部笔记' },
      keywords: { type: 'array', items: { type: 'string' }, description: '查询关键词（query 模式）' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签过滤（子串匹配，OR 内 AND 间）' },
      limit: { type: 'integer', description: '返回条数上限（默认 5，上限 20）' },
    },
  },
  dangerLevel: 'low',
}

export const kbQueryHandler: ToolHandler = async (args, ctx) => {
  const action = (argString(args.arguments, 'action') ?? 'query').toLowerCase()
  const store = new KbStore(ctx.workingDir)

  try {
    if (action === 'list') {
      const notes = await store.list()
      if (notes.length === 0) {
        return ok('知识库为空（.dev-assistant-kb/ 无笔记）。可用 kb_store 存入第一条。')
      }
      const lines = notes.map(
        (n, i) =>
          `${i + 1}. ${n.title}（id=${n.id}，更新 ${n.updatedAt.slice(0, 10)}）${n.tags.length > 0 ? ` [${n.tags.join(',')}]` : ''}`,
      )
      return ok(`知识库共 ${notes.length} 篇笔记:\n${lines.join('\n')}`)
    }

    // query 模式
    const keywords = (argStringArray(args.arguments, 'keywords') ?? []).filter((k) => typeof k === 'string')
    const tags = (argStringArray(args.arguments, 'tags') ?? []).filter((t) => typeof t === 'string')
    const limit = Math.min(20, Math.max(1, argNumber(args.arguments, 'limit') ?? 5))

    if (keywords.length === 0 && tags.length === 0) {
      return fail('kb_query 需要 keywords 或 tags 至少其一（或改用 action=list）')
    }

    const results = await store.query(keywords, tags, limit)
    if (results.length === 0) {
      return ok(`知识库中没有匹配「${keywords.join(' ')}」/标签「${tags.join(',')}」的笔记。`)
    }

    const blocks = results.map(({ note, score }, i) => {
      const preview =
        note.content.length > MAX_PREVIEW_CHARS ? `${note.content.slice(0, MAX_PREVIEW_CHARS)}\n…（已截断）` : note.content
      return `### ${i + 1}. ${note.title}（相关度 ${score.toFixed(2)}）\nid: ${note.id}${note.tags.length > 0 ? `\n标签: ${note.tags.join(', ')}` : ''}\n${preview}`
    })
    return ok(`命中 ${results.length} 篇笔记:\n\n${blocks.join('\n\n---\n\n')}`)
  } catch (e) {
    return fail(`知识库查询失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function ok(content: string) {
  return { success: true as const, content, restartRequested: false as const }
}
function fail(message: string) {
  return {
    success: false as const,
    content: message,
    restartRequested: false as const,
    errorCategory: 'permanent' as const,
  }
}
