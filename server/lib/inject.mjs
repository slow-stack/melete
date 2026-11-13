/**
 * 注入侧的纯函数：从 CreateMessageRequest 里取本轮提问、把记忆块并进 system。
 * CreateMessageRequest 契约锚点（src/services/api/types.ts:175）：
 *   { model, system: string, messages, thinking, tools, safety_check, title? }
 * system 是顶层字符串参数（store.ts:1003），不是消息角色——注入只动这一个字段。
 */

/**
 * 取最后一条 user 消息的纯文本，作为 /context 的查询词。
 * content 可能是 string，也可能是块数组（文件块在前、文本块在后，见 reply.ts toUserParam）。
 * 取不到（纯附件轮次）返回 ''——空查询走 /context 的规则档，画像与规则照常注入。
 */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) {
    return ''
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') {
      continue
    }
    const { content } = message
    if (typeof content === 'string') {
      return content.trim()
    }
    if (Array.isArray(content)) {
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      return text.trim()
    }
    return ''
  }
  return ''
}

/** 把记忆块并进现有 system。记忆块为空时原样返回（不追加空行）。 */
export function mergeSystem(system, memoryBlock) {
  if (!memoryBlock) {
    return system ?? ''
  }
  const existing = (system ?? '').trim()
  return existing ? `${existing}\n\n${memoryBlock}` : memoryBlock
}
