/**
 * SSE 旁路器：透传流的字节副本喂给一个增量解析器，收集蒸馏要用的正文。
 *
 * 设计约束：旁路绝不能影响透传——解析抛错只吞掉自己的那份（try/catch 在 write 里），
 * 主路字节一个不少地进客户端。这也是 mneme /context 注入回执那类「诊断与主路分离」
 * 的同一纪律：已经算好的东西，任何后续出错都不该把它丢掉。
 */
export function createSseTap(onEvent) {
  let buffer = ''
  return {
    /** 喂一段透传字节（string 或 Buffer）。内部解析失败静默丢弃，不外抛。 */
    write(chunk) {
      try {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        // SSE 事件以空行分隔；只处理到最近一个完整分隔符，剩余的留待下一段
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          for (const dataLine of rawEvent.split('\n')) {
            if (!dataLine.startsWith('data:')) {
              continue
            }
            const data = dataLine.slice(5).trim()
            if (!data || data === '[DONE]') {
              continue
            }
            try {
              onEvent(JSON.parse(data))
            } catch {
              // 非 JSON 数据帧（注释、保活）不属于内容流，跳过
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
        // 防御：异常流永远不出现空行时，缓冲区无界增长——超过 1MB 直接放弃旁路
        if (buffer.length > 1_000_000) {
          buffer = ''
        }
      } catch {
        // 旁路是纯诊断面，任何异常都不允许传染给透传
      }
    },
  }
}
