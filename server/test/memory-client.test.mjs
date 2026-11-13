import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createMemoryClient } from '../lib/memory-client.mjs'

// 锁 mneme 契约的请求形状。契约锚点 dsh-mneme/src/api-standalone.js：
// /context 的 scope 走 agent_scope/workspace_scope 两个 query 参数（scopeFromSearchParams:325），
// /memories 收显式 scope、source 字段，201=created / 200=merged / 422=write-rejected。

async function withStub(handler, run) {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    const record = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      raw: Buffer.concat(chunks).toString('utf8'),
    }
    requests.push(record)
    await handler(record, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    return await run({ baseUrl, requests })
  } finally {
    server.close()
  }
}

test('getContext: q/topK/scope 编码与 Bearer 头', async () => {
  await withStub(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ profile: 'P', rules: [], items: [], tier: 'full' }))
    },
    async ({ baseUrl, requests }) => {
      const memory = createMemoryClient({ baseUrl, token: 'tok-1', scopes: { agent_scope: 'melete', workspace_scope: 'chat' } })
      const context = await memory.getContext('自我介绍', { topK: 3 })
      assert.equal(context.tier, 'full')
      const record = requests[0]
      assert.equal(record.method, 'GET')
      assert.ok(record.url.startsWith('/context?'))
      const params = new URLSearchParams(record.url.split('?')[1])
      assert.equal(params.get('q'), '自我介绍')
      assert.equal(params.get('topK'), '3')
      assert.equal(params.get('agent_scope'), 'melete')
      assert.equal(params.get('workspace_scope'), 'chat')
      assert.equal(record.headers.authorization, 'Bearer tok-1')
    }
  )
})

test('getContext: q 中的中文与特殊字符走 URLSearchParams 编码', async () => {
  await withStub(
    (req, res) => res.end('{}'),
    async ({ baseUrl, requests }) => {
      const memory = createMemoryClient({ baseUrl, token: 't' })
      await memory.getContext('偏好&语言=Rust')
      const params = new URLSearchParams(requests[0].url.split('?')[1])
      assert.equal(params.get('q'), '偏好&语言=Rust')
    }
  )
})

test('saveMemory: 显式 scope + source=melete，created 动作透传', async () => {
  await withStub(
    (req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ action: 'created' }))
    },
    async ({ baseUrl, requests }) => {
      const memory = createMemoryClient({ baseUrl, token: 'tok-2', scopes: { agent_scope: 'melete', workspace_scope: 'chat' } })
      const saved = await memory.saveMemory({ type: 'summary', title: '自我介绍', content: '用户叫小明', importance: 4, tags: ['a'] })
      assert.equal(saved.action, 'created')
      const record = requests[0]
      assert.equal(record.method, 'POST')
      assert.equal(record.url, '/memories')
      const body = JSON.parse(record.raw)
      assert.equal(body.type, 'summary')
      assert.equal(body.title, '自我介绍')
      assert.equal(body.agent_scope, 'melete')
      assert.equal(body.workspace_scope, 'chat')
      assert.equal(body.source, 'melete')
      assert.equal(record.headers.authorization, 'Bearer tok-2')
    }
  )
})

test('saveMemory: 422 拒绝抛错而不是静默成功（写入准入语义对齐工具侧）', async () => {
  await withStub(
    (req, res) => {
      res.writeHead(422, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'write-rejected', reason: 'budget' }))
    },
    async ({ baseUrl }) => {
      const memory = createMemoryClient({ baseUrl, token: 't' })
      await assert.rejects(
        memory.saveMemory({ type: 'summary', title: 'x', content: 'y' }),
        /save 422/
      )
    }
  )
})

test('disabled 客户端：记忆缺席的正常读数，不发任何请求', async () => {
  await withStub(
    () => assert.fail('disabled 客户端不应发请求'),
    async ({ requests }) => {
      const memory = createMemoryClient({ baseUrl: 'http://127.0.0.1:1', token: '' })
      assert.equal(memory.enabled, false)
      const context = await memory.getContext('q')
      assert.deepEqual(context, { profile: '', rules: [], items: [], tier: 'unknown' })
      const saved = await memory.saveMemory({ type: 'summary', title: 'x', content: 'y' })
      assert.equal(saved.action, 'skipped')
      assert.equal(requests.length, 0)
    }
  )
})

test('baseUrl 尾斜杠归一，不产生 //context', async () => {
  await withStub(
    (req, res) => res.end('{}'),
    async ({ baseUrl, requests }) => {
      const memory = createMemoryClient({ baseUrl: `${baseUrl}/`, token: 't' })
      await memory.getContext('q')
      assert.ok(requests[0].url.startsWith('/context?'))
    }
  )
})
