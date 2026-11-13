import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMeleteServer } from '../server.mjs'

// 全链路集成：stub mneme + stub DeepSeek + 真 melete server（临时端口真听真发）。
// 锁三件行为契约：
// 1. 注入——上游收到的 system 必须是「原 system + mneme 块」，原 system 一个字不能丢；
// 2. 透传——SSE 字节逐块原样到客户端，不重排不丢块；
// 3. fail-open——mneme 挂了聊天照常（记忆缺席 ≠ 对话不可用）。

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const SSE_CHUNKS = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"，我是助手"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
]

const CONTEXT_FIXTURE = {
  profile: '用户是开发者',
  rules: ['回答用中文'],
  items: [{ type: 'summary', title: '自我介绍', content: '用户叫小明', importance: 3 }],
  pinnedCount: 0,
  tier: 'full',
}

async function createWorld({ mnemeToken = 'mneme-token-xyz', contextStatus = 200, logger = console } = {}) {
  // --- stub mneme ---
  const mneme = { contextCalls: [], listCalls: [], memories: [] }
  let mnemeContextStatus = contextStatus
  const mnemeServer = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/context')) {
      mneme.contextCalls.push({ url: req.url, authorization: req.headers.authorization })
      res.writeHead(mnemeContextStatus, { 'Content-Type': 'application/json' })
      res.end(mnemeContextStatus === 200 ? JSON.stringify(CONTEXT_FIXTURE) : '{"error":"boom"}')
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/memories')) {
      mneme.listCalls.push({ url: req.url, authorization: req.headers.authorization })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        items: [{ id: 'm1', type: 'summary', title: '自我介绍', content: '用户叫小明', importance: 3 }],
        total: 1,
      }))
      return
    }
    if (req.method === 'POST' && req.url === '/memories') {
      mneme.memories.push(JSON.parse(await readBody(req)))
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ action: 'created' }))
      return
    }
    res.writeHead(404).end()
  })

  // --- stub DeepSeek ---
  const deepseek = { chatRequests: [], distillRequests: [] }
  let distillReplyText = '{"type":"summary","title":"自我介绍","content":"用户叫小明","importance":4}'
  const deepseekServer = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/anthropic/v1/messages') {
      const body = JSON.parse(await readBody(req))
      if (body.stream === true) {
        deepseek.chatRequests.push(body)
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const chunk of SSE_CHUNKS) {
          res.write(chunk)
        }
        res.end()
        return
      }
      // 蒸馏调用（stream:false）：回复可由测试改写
      deepseek.distillRequests.push(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ content: [{ type: 'text', text: distillReplyText }] }))
      return
    }
    res.writeHead(404).end()
  })

  const mnemePort = await listen(mnemeServer)
  const deepseekPort = await listen(deepseekServer)

  const melete = createMeleteServer({
    distDir: null,
    apiOrigin: `http://127.0.0.1:${deepseekPort}`,
    mnemeUrl: `http://127.0.0.1:${mnemePort}`,
    mnemeToken,
    scopes: { agent_scope: 'melete', workspace_scope: 'chat' },
    allowOrigins: ['http://localhost:8090', 'http://127.0.0.1:8090'],
    distill: true,
    distillModel: 'deepseek-flash',
    logger,
  })
  const meletePort = await listen(melete)
  const base = `http://127.0.0.1:${meletePort}`

  const chat = (body, origin) =>
    fetch(`${base}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': 'sk-test',
        'Content-Type': 'application/json',
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(body),
    })

  const waitFor = async (predicate, timeoutMs = 3000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (predicate()) {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
  }

  const dispose = () => {
    melete.close()
    mnemeServer.close()
    deepseekServer.close()
  }

  return {
    base, chat, waitFor, dispose,
    mneme, deepseek,
    setDistillReply: (text) => { distillReplyText = text },
    setContextStatus: (status) => { mnemeContextStatus = status },
  }
}

const QUESTION = '我叫小明，喜欢 Rust'

test('全链路：注入 + 透传 + 蒸馏写回 + CORS', async () => {
  // 实测可观测性：注入回执与写回回执是「记忆两头真的动了」的终端读数，锁其形状
  const logs = []
  const logger = { info: (line) => logs.push(line), warn: () => {} }
  const world = await createWorld({ logger })
  try {
    const response = await world.chat(
      {
        model: 'deepseek-v4-pro',
        system: 'BASE SYSTEM',
        messages: [{ role: 'user', content: QUESTION }],
        stream: true,
      },
      'http://localhost:8090'
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:8090')

    // 透传：SSE 字节原样到客户端
    assert.equal(await response.text(), SSE_CHUNKS.join(''))

    // 注入：上游收到的 system = 原 system + mneme 块，原 system 完整保留
    assert.equal(world.deepseek.chatRequests.length, 1)
    const upstreamBody = world.deepseek.chatRequests[0]
    assert.ok(upstreamBody.system.startsWith('BASE SYSTEM'), '原 system 必须在前')
    assert.ok(upstreamBody.system.includes('<mneme-memory>'))
    assert.ok(upstreamBody.system.includes('用户叫小明'))
    assert.ok(upstreamBody.system.includes('用户是开发者'))
    assert.ok(upstreamBody.system.includes('- 回答用中文'))
    assert.deepEqual(upstreamBody.messages, [{ role: 'user', content: QUESTION }])

    // /context 调用形状：q=本轮提问，scope 双维 + Bearer
    assert.equal(world.mneme.contextCalls.length, 1)
    const params = new URLSearchParams(world.mneme.contextCalls[0].url.split('?')[1])
    assert.equal(params.get('q'), QUESTION)
    assert.equal(params.get('agent_scope'), 'melete')
    assert.equal(params.get('workspace_scope'), 'chat')
    assert.equal(params.get('topK'), '5')
    assert.equal(world.mneme.contextCalls[0].authorization, 'Bearer mneme-token-xyz')

    // 蒸馏写回：message_stop 之后 fire-and-forget，等它落库
    assert.ok(await world.waitFor(() => world.mneme.memories.length === 1), '蒸馏应在 3s 内写回')
    const memory = world.mneme.memories[0]
    assert.equal(memory.type, 'summary')
    assert.equal(memory.title, '自我介绍')
    assert.equal(memory.content, '用户叫小明')
    assert.equal(memory.importance, 4)
    assert.equal(memory.agent_scope, 'melete')
    assert.equal(memory.workspace_scope, 'chat')
    assert.equal(memory.source, 'melete')

    // 蒸馏调用本身：走蒸馏模型、非流式、带本轮正文
    assert.equal(world.deepseek.distillRequests.length, 1)
    const distillBody = world.deepseek.distillRequests[0]
    assert.equal(distillBody.model, 'deepseek-flash')
    assert.equal(distillBody.stream, false)
    assert.ok(distillBody.messages[0].content.includes('用户：我叫小明'))
    assert.ok(distillBody.messages[0].content.includes('助手：你好，我是助手'))

    // 终端读数：注入回执带条数与 tier，写回回执带动作与标题
    assert.ok(
      logs.some((line) => line.includes('已注入 1 条记忆') && line.includes('tier=full')),
      `应有注入回执，实际：${JSON.stringify(logs)}`
    )
    assert.ok(
      logs.some((line) => line.includes('记忆已写回') && line.includes('自我介绍')),
      `应有写回回执，实际：${JSON.stringify(logs)}`
    )

    // 注入读数响应头：徽标与实测的数据源
    assert.equal(response.headers.get('x-melete-injected-count'), '1')
    assert.equal(response.headers.get('x-melete-injected-tier'), 'full')
  } finally {
    world.dispose()
  }
})

test('fail-open：mneme /context 500 时聊天照常，system 原样转发', async () => {
  const world = await createWorld()
  world.setContextStatus(500)
  world.setDistillReply('{"skip":true}')
  try {
    const response = await world.chat({
      model: 'deepseek-v4-pro',
      system: 'BASE SYSTEM',
      messages: [{ role: 'user', content: QUESTION }],
        stream: true,
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), SSE_CHUNKS.join(''))
    const upstreamBody = world.deepseek.chatRequests[0]
    assert.equal(upstreamBody.system, 'BASE SYSTEM')
    // 注入缺席，但蒸馏独立工作（本轮照常评估是否值得记）
    assert.ok(await world.waitFor(() => world.deepseek.distillRequests.length === 1))
  } finally {
    world.dispose()
  }
})

test('记忆面关闭（无 token）：不发 /context、不蒸馏，纯代理', async () => {
  const world = await createWorld({ mnemeToken: '' })
  try {
    const response = await world.chat({
      model: 'deepseek-v4-pro',
      system: 'BASE SYSTEM',
      messages: [{ role: 'user', content: QUESTION }],
        stream: true,
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), SSE_CHUNKS.join(''))
    assert.equal(world.deepseek.chatRequests[0].system, 'BASE SYSTEM')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(world.mneme.contextCalls.length, 0)
    assert.equal(world.deepseek.distillRequests.length, 0)
    assert.equal(world.mneme.memories.length, 0)
  } finally {
    world.dispose()
  }
})

test('蒸馏输出 skip 时不写库', async () => {
  const world = await createWorld()
  world.setDistillReply('{"skip":true}')
  try {
    const response = await world.chat({
      model: 'deepseek-flash',
      system: '',
      messages: [{ role: 'user', content: '今天中午吃什么' }],
        stream: true,
    })
    assert.equal(response.status, 200)
    assert.ok(await world.waitFor(() => world.deepseek.distillRequests.length === 1))
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(world.mneme.memories.length, 0)
  } finally {
    world.dispose()
  }
})

test('蒸馏输出是垃圾时不写库（宁缺毋滥）', async () => {
  const world = await createWorld()
  world.setDistillReply('模型决定不配合，输出一段散文')
  try {
    const response = await world.chat({
      model: 'deepseek-flash',
      system: '',
      messages: [{ role: 'user', content: '闲聊一句' }],
        stream: true,
    })
    assert.equal(response.status, 200)
    assert.ok(await world.waitFor(() => world.deepseek.distillRequests.length === 1))
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(world.mneme.memories.length, 0)
  } finally {
    world.dispose()
  }
})

test('CORS：白名单源回显，陌生源无头；preflight 204', async () => {
  const world = await createWorld()
  try {
    const foreign = await fetch(`${world.base}/models`, { headers: { Origin: 'https://evil.example' } })
    assert.equal(foreign.headers.get('access-control-allow-origin'), null)
    await foreign.body?.cancel()

    const preflight = await fetch(`${world.base}/anthropic/v1/messages`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:8090',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-api-key,content-type',
      },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:8090')
  } finally {
    world.dispose()
  }
})

test('/models 透传：Authorization 原样转发', async () => {
  const world = await createWorld()
  try {
    const response = await fetch(`${world.base}/models`, {
      headers: { Authorization: 'Bearer sk-test' },
    })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.data[0].id, 'deepseek-flash')
  } finally {
    world.dispose()
  }
})

test('/mneme/memories 代理：GET 透传查询与鉴权，POST 缺省注入 scope 与 source', async () => {
  const world = await createWorld()
  try {
    const list = await fetch(`${world.base}/mneme/memories?source=melete&limit=20`)
    assert.equal(list.status, 200)
    const listBody = await list.json()
    assert.equal(listBody.total, 1)
    assert.equal(listBody.items[0].id, 'm1')
    assert.equal(world.mneme.listCalls[0].url, '/memories?source=melete&limit=20')
    assert.equal(world.mneme.listCalls[0].authorization, 'Bearer mneme-token-xyz')

    const add = await fetch(`${world.base}/mneme/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'summary', title: '手动条目', content: '用户手动添加' }),
    })
    assert.equal(add.status, 201)
    const manual = world.mneme.memories.at(-1)
    assert.equal(manual.agent_scope, 'melete')
    assert.equal(manual.workspace_scope, 'chat')
    assert.equal(manual.source, 'melete')
    assert.equal(manual.title, '手动条目')
  } finally {
    world.dispose()
  }
})

test('/mneme/memories：记忆面关闭时 503（不透传到无鉴权的上游）', async () => {
  const world = await createWorld({ mnemeToken: '' })
  try {
    const response = await fetch(`${world.base}/mneme/memories`)
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error, 'mneme-disabled')
    assert.equal(world.mneme.listCalls.length, 0)
  } finally {
    world.dispose()
  }
})

test('/mneme/status：诊断读数', async () => {
  const world = await createWorld()
  try {
    const response = await fetch(`${world.base}/mneme/status`)
    assert.equal(response.status, 200)
    const status = await response.json()
    assert.equal(status.mneme.tokenConfigured, true)
    assert.equal(status.mneme.reachable, true)
    assert.equal(status.proxy.distillEnabled, true)
    assert.ok(status.mneme.url.includes('127.0.0.1'))
  } finally {
    world.dispose()
  }
})

test('静态托管：dist 存在时 SPA fallback，路径穿越不泄漏', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'melete-dist-'))
  mkdirSync(join(dist, 'static', 'js'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>melete</title>')
  writeFileSync(join(dist, 'static', 'js', 'app.js'), 'console.log("app")')

  const server = createMeleteServer({ distDir: dist, mnemeToken: '' })
  const port = await listen(server)
  const base = `http://127.0.0.1:${port}`
  try {
    const index = await fetch(`${base}/`)
    assert.equal(await index.text(), '<!doctype html><title>melete</title>')

    const asset = await fetch(`${base}/static/js/app.js`)
    assert.equal(await asset.text(), 'console.log("app")')
    assert.match(asset.headers.get('content-type') ?? '', /javascript/)

    // 未知路径回 index.html（SPA 路由）
    const fallback = await fetch(`${base}/some/spa/route`)
    assert.equal(await fallback.text(), '<!doctype html><title>melete</title>')

    // 穿越尝试不得读 dist 之外的文件
    const traversal = await fetch(`${base}/..%2f..%2fetc%2fpasswd`)
    assert.equal(await traversal.text(), '<!doctype html><title>melete</title>')
  } finally {
    server.close()
  }
})

test('dist 未构建：非 API 路径给干净 404', async () => {
  const world = await createWorld()
  try {
    const response = await fetch(`${world.base}/`)
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error, 'dist-not-built')
  } finally {
    world.dispose()
  }
})
