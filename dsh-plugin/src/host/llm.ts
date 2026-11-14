/**
 * 临时聊天通道：host 服务代持 DeepSeek key，把浏览器页面的会话轮次转发给
 * 官方 Anthropic 兼容端点（无工具、关思考、非流式）。
 *
 * 这是**临时通道**——phase 2 换成 preset 激活的原生循环（会话落 DSH 存储、
 * mneme 钩子接管记忆）后退役。key 放 host config 而不是浏览器，与 melete
 * server 的安全纪律一致。
 */

export interface ChatTurnRouteHandler {
  /** DeepSeek API key（host config 持有，不下发浏览器）。 */
  readonly apiKey: string
  /** 聊天模型（快档）。 */
  readonly model: string
  /** Anthropic 兼容端点 origin。 */
  readonly apiOrigin: string
  /** 系统提示（persona 或缺省对话人格）。 */
  readonly systemPrompt: string
  /** 单轮请求体上限（字符数）。 */
  readonly maxTurnChars: number
}

type ClientTurn = { role: 'user' | 'assistant'; content: string }

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

/**
 * 聊天轮次路由：POST { messages: [{role, content}] } → { content }。
 * 校验轮次形状、上限与 key，转发上游；错误一律 JSON 化，页面可读。
 * @returns the Fetch handler registered on the Connection route.
 */
export function createChatTurnRoute(handler: ChatTurnRouteHandler): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!handler.apiKey) {
      return json(500, { error: 'apiKey missing: configure dsh-chat-mode in DSH settings' })
    }
    const raw = await request.text().catch(() => '')
    if (raw.length > handler.maxTurnChars) {
      return json(413, { error: 'turn too large' })
    }
    let body: unknown
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      return json(400, { error: 'invalid json' })
    }
    const rawMessages = (body as { messages?: unknown }).messages
    if (!Array.isArray(rawMessages)) {
      return json(400, { error: 'messages required' })
    }
    const messages: ClientTurn[] = []
    for (const item of rawMessages) {
      if (!item || typeof item !== 'object') {
        continue
      }
      const { role, content } = item as { role?: unknown; content?: unknown }
      if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
        messages.push({ role, content })
      }
    }
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
      return json(400, { error: 'last turn must be a user message' })
    }
    try {
      const upstream = await fetch(`${handler.apiOrigin}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': handler.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model: handler.model,
          system: handler.systemPrompt,
          messages,
          max_tokens: 4096,
          stream: false,
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!upstream.ok) {
        return json(502, { error: `upstream ${upstream.status}` })
      }
      const message = (await upstream.json()) as { content?: { type: string; text?: string }[] }
      const content = (message.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
      return json(200, { content })
    } catch (error) {
      return json(502, { error: String(error) })
    }
  }
}
