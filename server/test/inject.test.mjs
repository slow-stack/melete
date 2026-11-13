import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lastUserText, mergeSystem } from '../lib/inject.mjs'
import { renderMemoryBlock } from '../lib/memory-client.mjs'

// 锁注入点契约：system 是 CreateMessageRequest 的顶层字符串参数（types.ts:175），
// 这些用例防止有人把注入改成消息角色或丢掉已有 system（store.ts 的 SYSTEM_PROMPT 必须保留）。

test('lastUserText: 纯文本 content 直接取', () => {
  assert.equal(
    lastUserText([{ role: 'user', content: '  今天天气如何  ' }]),
    '今天天气如何'
  )
})

test('lastUserText: 块数组取文本块、跳过附件块（reply.ts toUserParam：文件在前文本在后）', () => {
  assert.equal(
    lastUserText([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'file', file_id: 'f1' } },
          { type: 'text', text: '这张图是什么' },
        ],
      },
    ]),
    '这张图是什么'
  )
})

test('lastUserText: 取最后一条 user，忽略其后的 assistant', () => {
  assert.equal(
    lastUserText([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: [{ type: 'text', text: '答' }] },
      { role: 'user', content: '第二问' },
    ]),
    '第二问'
  )
})

test('lastUserText: 纯附件轮次与空 messages 返回空串（走 /context 规则档）', () => {
  assert.equal(lastUserText([{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'f1' } }] }]), '')
  assert.equal(lastUserText([]), '')
  assert.equal(lastUserText(undefined), '')
})

test('mergeSystem: 已有 system 保留在前，记忆块并进在后', () => {
  const merged = mergeSystem('BASE PROMPT', '<mneme-memory>\n块\n</mneme-memory>')
  assert.equal(merged, 'BASE PROMPT\n\n<mneme-memory>\n块\n</mneme-memory>')
})

test('mergeSystem: system 缺失/空时记忆块直接成为 system', () => {
  assert.equal(mergeSystem('', '块'), '块')
  assert.equal(mergeSystem(undefined, '块'), '块')
})

test('mergeSystem: 记忆块为空时原样返回，不追加空行', () => {
  assert.equal(mergeSystem('BASE', ''), 'BASE')
  assert.equal(mergeSystem(undefined, ''), '')
})

// 锁渲染形状：注入块是给模型看的，围栏标签与画像/规则/记忆三段一个不能少；
// 空库必须返回空串——这是「不注入」的信号，不是空块。
test('renderMemoryBlock: 画像/规则/记忆三段齐全', () => {
  const block = renderMemoryBlock({
    profile: '用户是开发者',
    rules: ['回答用中文', '先给结论'],
    items: [
      { type: 'summary', title: '自我介绍', content: '用户叫小明', importance: 3 },
      { type: 'preference', title: '语言偏好', content: '喜欢 Rust', importance: 4 },
    ],
  })
  assert.ok(block.startsWith('<mneme-memory>'))
  assert.ok(block.endsWith('</mneme-memory>'))
  assert.ok(block.includes('用户是开发者'))
  assert.ok(block.includes('- 回答用中文'))
  assert.ok(block.includes('- [summary] 自我介绍: 用户叫小明'))
  assert.ok(block.includes('- [preference] 语言偏好: 喜欢 Rust'))
})

test('renderMemoryBlock: 空库返回空串（调用方跳过注入）', () => {
  assert.equal(renderMemoryBlock({ profile: '', rules: [], items: [] }), '')
  assert.equal(renderMemoryBlock({}), '')
  assert.equal(renderMemoryBlock({ profile: '   ', rules: [], items: [null, { title: '', content: '' }] }), '')
})
