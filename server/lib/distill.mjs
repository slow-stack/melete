/**
 * 蒸馏侧的纯函数：从一轮问答里提出值得记住的事，解析模型输出。
 *
 * daemon 第一期无 LLM（DAEMON.md §1：巩固/蒸馏结构性缺失，不是开关），
 * 所以 melete 在传输层自己蒸馏——用的是用户已经在用的 DeepSeek key，
 * 蒸完 POST /memories 写回。日后 melete 自成宿主时，这里换成宿主 LLM 句柄即可。
 */

import { MEMORY_TYPES } from './memory-client.mjs'

/** 单轮蒸馏的输入预算：两端各截断，防止超长会话把蒸馏调用本身变成大开销 */
export const DISTILL_TEXT_BUDGET = 4000

const DISTILL_SYSTEM = [
  '你负责从一段对话里提取值得长期记住的信息，写进用户的记忆库。',
  '只提取这些类型之一：preference（用户偏好）、decision（做出的决定）、summary（事实性摘要）、pattern（反复出现的行为模式）、history（发生的事件）。',
  '规则：',
  '- 只记「对未来的对话有用」的内容：稳定的偏好、决定、事实；寒暄、闲聊、一次性问题一律跳过。',
  '- 用户的明确偏好最高优先；你自己的回答里的事实只有当它是「关于用户的」或「用户项目相关的」稳定信息时才记。',
  '- title 必须稳定可复用（同一主题的同类对话应产出相同 title，如「编程语言偏好」），不超过 30 字。',
  '- content 是给未来对话看的自包含陈述，不超过 200 字，不写「刚才」「上面」这类指代。',
  '- importance 1-5：偏好和决定 4，一般事实 3。',
  '- 没有值得记的就输出 {"skip":true}，不要硬凑。',
  '只输出一个 JSON 对象，不要输出任何其他文字：',
  '{"skip":true} 或 {"type":"...","title":"...","content":"...","importance":3,"tags":["..."]}',
].join('\n')

/** 拼蒸馏请求的 messages。两端截断到预算内。 */
export function buildDistillMessages(userText, assistantText) {
  const user = userText.slice(0, DISTILL_TEXT_BUDGET)
  const assistant = assistantText.slice(0, DISTILL_TEXT_BUDGET)
  return {
    system: DISTILL_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `对话片段：\n\n用户：${user}\n\n助手：${assistant || '（本轮无正文）'}`,
      },
    ],
  }
}

/** 剥掉 ```json 围栏（LLM 爱加，mneme 的 fence.js 沉淀过同类坑） */
function stripFence(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  return (fenced ? fenced[1] : text).trim()
}

/**
 * 解析蒸馏输出。三种结果：
 *   { skip: true }            —— 模型判断没有值得记的
 *   { memory: {type,...} }    —— 合法的记忆
 *   null                      —— 解析失败（fail-open：丢弃，只留日志）
 */
export function parseDistillOutput(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(stripFence(text))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null
  }
  if (parsed.skip === true) {
    return { skip: true }
  }
  const { type, title, content, importance, tags } = parsed
  if (!MEMORY_TYPES.has(type) || typeof title !== 'string' || !title.trim()) {
    return null
  }
  if (typeof content !== 'string' || !content.trim()) {
    return null
  }
  const importanceNumber = Number(importance)
  return {
    memory: {
      type,
      title: title.trim().slice(0, 60),
      content: content.trim(),
      ...(Number.isInteger(importanceNumber) && importanceNumber >= 1 && importanceNumber <= 5
        ? { importance: importanceNumber }
        : {}),
      ...(Array.isArray(tags) && tags.length > 0
        ? { tags: tags.filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, 5) }
        : {}),
    },
  }
}

/** 从被旁路的 SSE 事件流里拼出 assistant 正文（text_delta 累加）。 */
export function assistantTextFromEvents(events) {
  return events
    .filter(
      (event) =>
        event?.type === 'content_block_delta' &&
        event?.delta?.type === 'text_delta' &&
        typeof event.delta.text === 'string'
    )
    .map((event) => event.delta.text)
    .join('')
}
