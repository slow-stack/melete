/**
 * mneme 记忆契约层——melete 与 mneme 的全部接触面都收在这一个文件里。
 *
 * 这个模块是三条路线（web 前端 / 桌面 APP / dsh-Go 式手机宿主）共用的耐久层：
 * 日后换传输方式（进程内嵌、远端 daemon）只换这里的 transport 实现，调用方不动。
 *
 * 契约锚点（dsh-mneme/src/api-standalone.js）：
 * - GET /context?q=&topK=&agent_scope=&workspace_scope= → { profile, rules, items, pinnedCount, tier }
 *   （tier: full=语义档 / degraded=规则档 / unknown=判不出来，fail-closed）
 * - POST /memories { type, title, content, importance?, tags?, agent_scope?, workspace_scope?, source? }
 *   → 201 created / 200 merged（去重键 type+title+scope 三元组）/ 422 write-rejected
 * - 鉴权：Authorization: Bearer <token>（与 DSH 面板 / CLI 共用同一份 token）
 *
 * 纪律：记忆面故障一律 fail-open——聊天继续，记忆静默缺席，只留一行 stderr。
 * 记忆缺席是可用的降级，不该拖垮对话本身。
 */

/** 注入候选的类型上限：daemon 侧 injectCandidates 已过滤，这里只是文档化读数 */
export const CONTEXT_DEFAULT_TOP_K = 5

/** 蒸馏回写允许的 type 白名单（store.js TYPES 的子集，排除 document 的旁路铸造与纯编码类） */
export const MEMORY_TYPES = new Set(['preference', 'decision', 'summary', 'pattern', 'history'])

/** 默认 scope：与宿主侧的 agent/workspace 双维对齐，melete 是自己的 agent 域 */
export const DEFAULT_SCOPES = { agent_scope: 'melete', workspace_scope: 'chat' }

/**
 * GET /context。q 为空时也照发（daemon 返回 profile+rules 的规则档），
 * 因为注入块里的画像与规则不依赖查询词。
 */
export async function getContext(client, q, { topK = CONTEXT_DEFAULT_TOP_K, signal } = {}) {
  const params = new URLSearchParams({ q, topK: String(topK) })
  if (client.scopes.agent_scope) {
    params.set('agent_scope', client.scopes.agent_scope)
  }
  if (client.scopes.workspace_scope) {
    params.set('workspace_scope', client.scopes.workspace_scope)
  }
  const response = await fetch(`${client.baseUrl}/context?${params}`, {
    headers: { Authorization: `Bearer ${client.token}` },
    signal,
  })
  if (!response.ok) {
    throw new Error(`context ${response.status}`)
  }
  return response.json()
}

/**
 * POST /memories。返回 { action: 'created' | 'merged' }；
 * 非法 type 由调用方在白名单处拦截，这里不再重复校验。
 */
export async function saveMemory(client, memory) {
  const response = await fetch(`${client.baseUrl}/memories`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${client.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...memory,
      agent_scope: client.scopes.agent_scope,
      workspace_scope: client.scopes.workspace_scope,
      source: 'melete',
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`save ${response.status}`)
  }
  return response.json()
}

/**
 * 把 /context 的答复渲染成可拼进 system 的文本块。纯函数。
 * 空库（profile/rules/items 全空）返回 ''，调用方以此跳过注入。
 */
export function renderMemoryBlock({ profile, rules, items }) {
  const lines = []
  const trimmedProfile = (profile ?? '').trim()
  if (trimmedProfile) {
    lines.push(`## User profile / 用户画像\n${trimmedProfile}`)
  }
  if (Array.isArray(rules) && rules.length > 0) {
    lines.push(
      `## Rules / 规则\n${rules.map((rule) => `- ${rule}`).join('\n')}`
    )
  }
  const memories = (items ?? []).filter((item) => item?.title || item?.content)
  if (memories.length > 0) {
    lines.push(
      `## Related memories / 相关记忆\n${memories
        .map((item) => `- [${item.type}] ${item.title}: ${(item.content ?? '').trim()}`)
        .join('\n')}`
    )
  }
  if (lines.length === 0) {
    return ''
  }
  return [
    '<mneme-memory>',
    '以下内容来自本机 mneme 记忆库的自动召回，供回答时参考；',
    '与当前对话冲突时以对话为准，用户明说的永远优先于历史记忆。',
    'The following is recalled from the local mneme memory store; the current conversation takes precedence.',
    '',
    ...lines,
    '</mneme-memory>',
  ].join('\n')
}

/**
 * 组装一个记忆客户端。token 为空时返回 disabled 客户端——
 * 调用方不需要到处判空，disabled 客户端的每个方法都返回「记忆缺席」的正常读数。
 */
export function createMemoryClient({
  baseUrl = 'http://127.0.0.1:8790',
  token = '',
  scopes = DEFAULT_SCOPES,
  logger = console,
} = {}) {
  const client = {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    token,
    scopes,
    enabled: Boolean(token),
    logger,
  }
  return {
    client,
    enabled: client.enabled,
    getContext: (q, opts) =>
      client.enabled ? getContext(client, q, opts) : Promise.resolve({ profile: '', rules: [], items: [], tier: 'unknown' }),
    saveMemory: (memory) =>
      client.enabled
        ? saveMemory(client, memory)
        : Promise.resolve({ action: 'skipped', reason: 'mneme-disabled' }),
    renderMemoryBlock,
  }
}
