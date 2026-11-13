import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDistillMessages,
  parseDistillOutput,
  assistantTextFromEvents,
  DISTILL_TEXT_BUDGET,
} from '../lib/distill.mjs'

// 蒸馏是写库的唯一入口，解析器必须宁缺毋滥：垃圾输出一律 null（fail-open 丢弃），
// 白名单外的 type 一律拒收——mneme 的 TYPES 白名单（store.js:524）在客户端先挡一道。

test('buildDistillMessages: 拼接用户与助手正文，带 system 指令', () => {
  const { system, messages } = buildDistillMessages('我叫小明，喜欢 Rust', '你好小明！')
  assert.ok(system.includes('{"skip":true}'))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.ok(messages[0].content.includes('用户：我叫小明，喜欢 Rust'))
  assert.ok(messages[0].content.includes('助手：你好小明！'))
})

test('buildDistillMessages: 超长输入截断到预算', () => {
  const long = 'x'.repeat(DISTILL_TEXT_BUDGET + 500)
  const { messages } = buildDistillMessages(long, long)
  assert.ok(!messages[0].content.includes('x'.repeat(DISTILL_TEXT_BUDGET + 1)))
})

test('parseDistillOutput: 合法记忆', () => {
  const parsed = parseDistillOutput(
    '{"type":"summary","title":"自我介绍","content":"用户叫小明","importance":4,"tags":["a","b"]}'
  )
  assert.deepEqual(parsed.memory, {
    type: 'summary',
    title: '自我介绍',
    content: '用户叫小明',
    importance: 4,
    tags: ['a', 'b'],
  })
})

test('parseDistillOutput: 容忍 ```json 围栏与前后杂音', () => {
  const parsed = parseDistillOutput('```json\n{"type":"decision","title":"换框架","content":"决定用 SolidJS"}\n```')
  assert.equal(parsed.memory.type, 'decision')
  assert.equal(parsed.memory.title, '换框架')
})

test('parseDistillOutput: skip 输出', () => {
  assert.deepEqual(parseDistillOutput('{"skip":true}'), { skip: true })
})

test('parseDistillOutput: 白名单外 type / 缺 title / 缺 content 拒收', () => {
  assert.equal(parseDistillOutput('{"type":"document","title":"x","content":"y"}'), null)
  assert.equal(parseDistillOutput('{"type":"summary","title":"  ","content":"y"}'), null)
  assert.equal(parseDistillOutput('{"type":"summary","title":"x"}'), null)
  assert.equal(parseDistillOutput('{"type":"summary","title":"x","content":"  "}'), null)
})

test('parseDistillOutput: 非法 importance 被丢弃而不是拒绝整条', () => {
  const parsed = parseDistillOutput('{"type":"summary","title":"x","content":"y","importance":99}')
  assert.equal(parsed.memory.importance, undefined)
  assert.equal(parsed.memory.title, 'x')
})

test('parseDistillOutput: 垃圾输出一律 null', () => {
  assert.equal(parseDistillOutput(''), null)
  assert.equal(parseDistillOutput('这不是 JSON'), null)
  assert.equal(parseDistillOutput('[1,2,3]'), null)
  assert.equal(parseDistillOutput('null'), null)
  assert.equal(parseDistillOutput(42), null)
})

// SSE 旁路的事件筛选：thinking_delta / 工具块 / 标题 delta 都不能混进正文
test('assistantTextFromEvents: 只累加 text_delta', () => {
  const text = assistantTextFromEvents([
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: '思考' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，世界' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: {} } },
    { type: 'message_stop' },
  ])
  assert.equal(text, '你好，世界')
})
