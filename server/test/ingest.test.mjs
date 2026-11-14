import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'

import {
  readArchive,
  linearizeBranch,
  extractPairs,
  buildSessionText,
  buildSessionDistillMessages,
  parseSessionDistillOutput,
} from '../lib/ingest.mjs'

// ingest 的解析层锁三件事：v3 manifest 校验、按 current_message_id 线性化
// （官方定义的唯一依据，旁支的 FAILED 轮不得混入）、夹具蒸馏输出的白名单过滤。

const user = (id, parentId, content) => ({
  id,
  parent_id: parentId,
  role: 'USER',
  status: 'FINISHED',
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: '2026-01-01T00:00:00Z',
  fragments: [{ type: 'REQUEST', content }],
})
const assistant = (id, parentId, content, status = 'FINISHED', extra = []) => ({
  id,
  parent_id: parentId,
  role: 'ASSISTANT',
  status,
  thinking_enabled: false,
  search_enabled: false,
  accumulated_token_usage: 0,
  inserted_at: '2026-01-01T00:01:00Z',
  fragments: [...extra, { type: 'RESPONSE', content }],
})

function makeZip(entries) {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, strToU8(JSON.stringify(data))])))
}

const INDEX = [
  { id: 's1', title: 'Rust 学习', pinned: false, message_count: 4, inserted_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:02:00Z' },
  { id: 's2', title: '空会话', pinned: false, message_count: 0, inserted_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
]

const S1 = {
  id: 's1',
  title: 'Rust 学习',
  pinned: false,
  current_message_id: 4,
  inserted_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:02:00Z',
  messages: [
    user(1, null, '我想学 Rust'),
    assistant(2, 1, 'Rust 的所有权模型是切入点', 'FINISHED', [{ type: 'THINK', content: '内部思考', elapsed_secs: 1 }]),
    user(3, 2, '借用检查器呢'),
    assistant(4, 3, '借用检查器在编译期拦截悬垂引用'),
    // 旁支：早期一次失败的提问，不在 current 分支上
    assistant(5, 2, '这条回答失败了', 'FAILED'),
  ],
}

const S2 = { id: 's2', title: '空会话', pinned: false, current_message_id: 0, inserted_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', messages: [] }

function fixtureZip({ version = 3 } = {}) {
  return makeZip({
    'manifest.json': { export_format_version: version },
    'chat_session_index.json': INDEX,
    'chat_sessions/s1.json': S1,
    'chat_sessions/s2.json': S2,
  })
}

test('readArchive：v3 校验 + 会话归集', () => {
  const { index, sessions } = readArchive(fixtureZip())
  assert.equal(index.length, 2)
  assert.equal(sessions.get('s1').current_message_id, 4)
  assert.throws(() => readArchive(fixtureZip({ version: 2 })), /不支持的导出格式版本/)
  assert.throws(() => readArchive(makeZip({ 'chat_session_index.json': INDEX })), /manifest/)
})

test('linearizeBranch：沿 current_message_id 回溯父链，旁支 FAILED 轮不混入', () => {
  const branch = linearizeBranch(S1)
  assert.deepEqual(branch.map((message) => message.id), [1, 2, 3, 4])
})

test('extractPairs：REQUEST/RESPONSE 配对，THINK 剥除，FAILED 不进对', () => {
  const branch = linearizeBranch(S1)
  const pairs = extractPairs(branch)
  assert.equal(pairs.length, 2)
  assert.deepEqual(pairs[0], { user: '我想学 Rust', assistant: 'Rust 的所有权模型是切入点' })
  assert.equal(pairs[1].assistant, '借用检查器在编译期拦截悬垂引用')
  // 无 FAILED 轮被当作回答：4 条消息只产 2 对
})

test('extractPairs：INCOMPLETE 且有正文的回答可用，空正文轮整个轮次丢弃', () => {
  const session = {
    ...S1,
    current_message_id: 4,
    messages: [
      user(1, null, '问题'),
      assistant(2, 1, '', 'INCOMPLETE'),
      user(3, 2, '追问'),
      assistant(4, 3, '部分回答', 'INCOMPLETE'),
    ],
  }
  const pairs = extractPairs(linearizeBranch(session))
  // 首轮回答为空 → 该轮整体不进蒸馏；次轮可用
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].user, '追问')
  assert.equal(pairs[0].assistant, '部分回答')
})

test('buildSessionText：预算内全量；超预算头 2 轮 + 尾轮采样并折叠中段', () => {
  const pairs = Array.from({ length: 40 }, (_, i) => ({ user: `问题${i}`, assistant: `回答${i}` }))
  const full = buildSessionText(pairs)
  assert.ok(full.includes('问题0') && full.includes('回答39'))
  assert.ok(!full.includes('中间省略'))
  const text = buildSessionText(pairs, 400)
  assert.ok(text.length <= 440, `实际 ${text.length}`)
  assert.ok(text.startsWith('用户：问题0'))
  assert.ok(text.includes('中间省略'))
  assert.ok(text.includes('回答39'), '尾轮应保留最近的')
})

test('buildSessionDistillMessages：预算内文本 + 会话蒸馏 system', () => {
  const { system, messages } = buildSessionDistillMessages('用户：你好\n助手：你好！')
  assert.ok(system.includes('{"memories":[]}'))
  assert.ok(messages[0].content.includes('历史会话记录'))
})

test('parseSessionDistillOutput：合法多条 / 围栏 / 垃圾 / 超量截断', () => {
  const parsed = parseSessionDistillOutput('```json\n{"memories":[{"type":"summary","title":"Rust 起点","content":"从所有权模型入门","importance":3},{"type":"decision","title":"IDE","content":"用 VS Code"}]}\n```')
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].type, 'summary')
  assert.deepEqual(parseSessionDistillOutput('{"memories":[]}'), [])
  assert.equal(parseSessionDistillOutput('模型自由发挥'), null)
  assert.equal(parseSessionDistillOutput('{"type":"summary","title":"x"}'), null)
  const over = parseSessionDistillOutput(JSON.stringify({ memories: Array.from({ length: 5 }, (_, i) => ({ type: 'summary', title: `t${i}`, content: 'c' })) }))
  assert.equal(over.length, 3)
})
