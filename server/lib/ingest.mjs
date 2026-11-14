/**
 * 会话档案批量蒸馏（ingest）的纯函数层：ZIP 解析、消息树线性化、
 * 会话蒸馏 prompt 与输出解析。CLI 在 scripts/ingest.mjs。
 *
 * 为什么按会话而不是按轮：两年的记录里值得长期记住的是「稳定的偏好、
 * 决定、模式」，一次调用提炼一个会话的 0-3 条，比逐轮蒸馏便宜两个数量级。
 */

import { unzipSync, strFromU8 } from 'fflate'
import { MEMORY_TYPES } from './memory-client.mjs'

export const EXPORT_FORMAT_VERSION = 3

/** 单会话喂给蒸馏的字符预算；超长会话头尾采样，中段折叠 */
export const SESSION_TEXT_BUDGET = 12000

/** 解包 ZIP 并校验 manifest。返回 { index, sessions: Map<id, SessionFile> } */
export function readArchive(zipBuffer) {
  const entries = unzipSync(new Uint8Array(zipBuffer))
  const names = Object.keys(entries).sort()
  const manifestName = names.find((name) => name.endsWith('manifest.json'))
  if (!manifestName) {
    throw new Error('缺少 manifest.json——确认这是 DeepSeek 官方导出的 deepseek_data-*.zip')
  }
  const manifest = JSON.parse(strFromU8(entries[manifestName]))
  if (manifest.export_format_version !== EXPORT_FORMAT_VERSION) {
    throw new Error(`不支持的导出格式版本 ${manifest.export_format_version}（只认 v${EXPORT_FORMAT_VERSION}）`)
  }
  const indexName = names.find((name) => name.endsWith('chat_session_index.json'))
  if (!indexName) {
    throw new Error('缺少 chat_session_index.json')
  }
  const index = JSON.parse(strFromU8(entries[indexName]))
  const sessions = new Map()
  for (const name of names) {
    const match = name.match(/chat_sessions\/([^/]+)\.json$/)
    if (match && !name.includes('_files/')) {
      sessions.set(match[1], JSON.parse(strFromU8(entries[name])))
    }
  }
  return { index, sessions }
}

/**
 * 按 current_message_id（官方定义的线性化唯一依据）回溯父链取当前分支，
 * 根在前。分支点取 max-id 子消息与官方默认选择规则一致——但我们直接沿
 * current_message_id 的父链走，天然就是用户停留的那条分支。
 */
export function linearizeBranch(session) {
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const branch = []
  let cursor = session.messages.find((message) => message.id === session.current_message_id)
  while (cursor) {
    branch.unshift(cursor)
    cursor = cursor.parent_id === null ? undefined : byId.get(cursor.parent_id)
  }
  return branch
}

/** 从分支里抽 (user, assistant) 文本对：只认 REQUEST/RESPONSE 片段，残缺轮跳过 */
export function extractPairs(branch) {
  const pairs = []
  let pendingUser = null
  for (const message of branch) {
    const text = message.fragments
      .filter((fragment) => fragment.type === 'REQUEST' || fragment.type === 'RESPONSE')
      .map((fragment) => (fragment.content ?? '').trim())
      .filter(Boolean)
      .join('\n')
    if (message.role === 'USER') {
      pendingUser = text
    } else if (pendingUser !== null) {
      // FAILED / 超限 / 拒绝等非完成回答不进蒸馏；空回答的轮次同样跳过
      const usable =
        message.status === 'FINISHED' || message.status === 'INCOMPLETE' ? text : ''
      if (usable) {
        pairs.push({ user: pendingUser, assistant: usable })
      }
      pendingUser = null
    }
  }
  return pairs
}

/** 会话文本：头 2 轮 + 尽量多的尾轮，预算内装不下时折叠中段 */
export function buildSessionText(pairs, budget = SESSION_TEXT_BUDGET) {
  const render = (pair) => `用户：${pair.user}\n助手：${pair.assistant}`
  if (pairs.length === 0) {
    return ''
  }
  const head = pairs.slice(0, 2)
  const headText = head.map(render).join('\n\n')
  if (headText.length >= budget) {
    return headText.slice(0, budget)
  }
  // 尾轮从最近的往前收：每段按自身 + 段间分隔计费，并预留给中段折叠标记，
  // 否则标记和 join 分隔会把总量悄悄顶出预算
  const tail = []
  let used = headText.length + 40
  for (let i = pairs.length - 1; i >= head.length; i--) {
    const piece = render(pairs[i])
    if (used + piece.length + 2 > budget) {
      break
    }
    tail.unshift(piece)
    used += piece.length + 2
  }
  const skipped = pairs.length - head.length - tail.length
  const middle = skipped > 0 ? `\n\n……（中间省略 ${skipped} 轮）……\n\n` : '\n\n'
  return `${headText}${middle}${tail.join('\n\n')}`
}

const SESSION_DISTILL_SYSTEM = [
  '你负责从一段历史会话记录里提取值得长期记住的信息，写进用户的记忆库。',
  '只提取这些类型之一：preference（用户偏好）、decision（做出的决定）、summary（事实性摘要）、pattern（反复出现的行为模式）、history（发生的事件）。',
  '规则：',
  '- 只提取「对未来对话有用」的稳定信息：明确的偏好、决定、项目事实、反复出现的行为；寒暄、一次性问答、时效性内容一律不记。',
  '- 最多 3 条，没有值得记的就输出 {"memories":[]}，不要硬凑。',
  '- title 必须稳定可复用（同一主题的会话应产出相同 title），不超过 30 字。',
  '- content 是给未来对话看的自包含陈述，不超过 200 字，不写「这个会话里」这类指代。',
  '- importance 1-5：明确偏好和决定 4，一般事实 3。',
  '只输出一个 JSON 对象：{"memories":[{"type":"...","title":"...","content":"...","importance":3,"tags":["..."]}] 或 {"memories":[]}',
].join('\n')

/** 会话蒸馏请求体（头尾采样 + 预算折叠在 buildSessionText 已完成） */
export function buildSessionDistillMessages(sessionText) {
  return {
    system: SESSION_DISTILL_SYSTEM,
    messages: [{ role: 'user', content: `历史会话记录：\n\n${sessionText}` }],
  }
}

/** 校验单条记忆（与轮次蒸馏同一套白名单与形状约束），非法返回 null */
function validateMemory(item) {
  if (!item || typeof item !== 'object') {
    return null
  }
  const { type, title, content, importance, tags } = item
  if (!MEMORY_TYPES.has(type) || typeof title !== 'string' || !title.trim()) {
    return null
  }
  if (typeof content !== 'string' || !content.trim()) {
    return null
  }
  const importanceNumber = Number(importance)
  return {
    type,
    title: title.trim().slice(0, 60),
    content: content.trim(),
    ...(Number.isInteger(importanceNumber) && importanceNumber >= 1 && importanceNumber <= 5
      ? { importance: importanceNumber }
      : {}),
    ...(Array.isArray(tags)
      ? { tags: tags.filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, 5) }
      : {}),
  }
}

function stripFence(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  return (fenced ? fenced[1] : text).trim()
}

/** 解析会话蒸馏输出：最多 3 条合法记忆；整体解析失败返回 null（fail-open 跳过该会话） */
export function parseSessionDistillOutput(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(stripFence(text))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.memories)) {
    return null
  }
  return parsed.memories.map(validateMemory).filter(Boolean).slice(0, 3)
}
