/**
 * 网页内批量蒸馏：把本地会话提炼成记忆写进 mneme——纯浏览器实现。
 *
 * 为什么在浏览器做：数据已在 IndexedDB、DeepSeek key 已在设置里（聊天同一条
 * 通道直调 api.deepseek.com），写入走伴随服务的 /mneme/memories 代理（mneme
 * token 只在 server 侧）。对终端用户是「设置 → 记忆 → 整理历史会话」一个按钮，
 * 不需要终端。
 *
 * 蒸馏契约与 server/scripts/ingest.mjs（CLI 版）保持同构：按会话提炼 0-3 条
 * 稳定事实、白名单类型、稳定标题——两侧任一改动都要对齐另一侧。
 */

import { getContextRounds } from '../chat/reply.js'
import type { Session } from '../chat/types.js'
import { API_ORIGIN } from '../api/client.js'

export const MEMORY_TYPES = ['preference', 'decision', 'summary', 'pattern', 'history'] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

export type MemoryDraft = {
  type: MemoryType
  title: string
  content: string
  importance?: number
  tags?: string[]
}

/** 单会话喂给蒸馏的字符预算；超长会话头尾采样，中段折叠 */
export const SESSION_TEXT_BUDGET = 12000

export type SessionPlan = {
  sessionId: string
  title: string
  turns: number
  chars: number
  text: string
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
  '只输出一个 JSON 对象：{"memories":[{"type":"...","title":"...","content":"...","importance":3,"tags":["..."]}]} 或 {"memories":[]}',
].join('\n')

/** 会话文本：头 2 轮 + 尽量多的尾轮，预算内装不下时折叠中段（计费含段间分隔与折叠标记） */
export function buildSessionText(
  pairs: { user: string; assistant: string }[],
  budget = SESSION_TEXT_BUDGET
): string {
  const render = (pair: { user: string; assistant: string }) => `用户：${pair.user}\n助手：${pair.assistant}`
  if (pairs.length === 0) {
    return ''
  }
  const head = pairs.slice(0, 2)
  const headText = head.map(render).join('\n\n')
  if (headText.length >= budget) {
    return headText.slice(0, budget)
  }
  const tail: string[] = []
  // 预留折叠标记与分隔的开销，否则它们会把总量悄悄顶出预算
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

/** 从一个本地会话规划蒸馏输入：复用 getContextRounds 的「可用轮次」判据 */
export function planSession(session: Session, budget = SESSION_TEXT_BUDGET): SessionPlan | null {
  const pairs = getContextRounds(session.messages).map(([user, assistant]) => ({
    user: user.content,
    assistant: assistant.blocks
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join(''),
  }))
  if (pairs.length === 0) {
    return null
  }
  const text = buildSessionText(pairs, budget)
  return { sessionId: session.id, title: session.title, turns: pairs.length, chars: text.length, text }
}

function stripFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  return (fenced ? fenced[1] : text).trim()
}

/** 解析会话蒸馏输出：最多 3 条合法记忆；整体解析失败返回 null（fail-open 跳过） */
export function parseSessionDistillOutput(text: string): MemoryDraft[] | null {
  if (!text.trim()) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(text))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { memories?: unknown }).memories)) {
    return null
  }
  const drafts: MemoryDraft[] = []
  for (const item of (parsed as { memories: unknown[] }).memories) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const record = item as Record<string, unknown>
    const { type, title, content, importance, tags } = record
    if (
      !MEMORY_TYPES.includes(type as MemoryType) ||
      typeof title !== 'string' ||
      !title.trim() ||
      typeof content !== 'string' ||
      !content.trim()
    ) {
      continue
    }
    const importanceNumber = Number(importance)
    drafts.push({
      type: type as MemoryType,
      title: title.trim().slice(0, 60),
      content: content.trim(),
      ...(Number.isInteger(importanceNumber) && importanceNumber >= 1 && importanceNumber <= 5
        ? { importance: importanceNumber }
        : {}),
      ...(Array.isArray(tags)
        ? { tags: tags.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim()).slice(0, 5) }
        : {}),
    })
  }
  return drafts.slice(0, 3)
}

/** 调 DeepSeek（非流式）蒸馏一个会话。与聊天同一条 API 通道、同一个 key。 */
export async function distillSession(
  sessionText: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal
): Promise<MemoryDraft[] | null> {
  const response = await fetch(`${API_ORIGIN}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model,
      system: SESSION_DISTILL_SYSTEM,
      messages: [{ role: 'user', content: `历史会话记录：\n\n${sessionText}` }],
      max_tokens: 1200,
      stream: false,
    }),
    signal,
  })
  if (!response.ok) {
    throw new Error(`distill ${response.status}`)
  }
  const message = (await response.json()) as {
    content?: { type: string; text?: string }[]
  }
  const text = (message.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  return parseSessionDistillOutput(text)
}

/** 经伴随服务代理写一条记忆进 mneme（scope 与 source 由 server 缺省注入） */
export async function saveMemoryDraft(draft: MemoryDraft, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/mneme/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
    signal,
  })
  if (!response.ok) {
    throw new Error(`save ${response.status}`)
  }
}
