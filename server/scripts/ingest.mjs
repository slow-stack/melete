/**
 * melete ingest：把 DeepSeek 官方导出的历史会话 ZIP 批量蒸馏进 mneme 记忆库。
 *
 * 用法：
 *   node server/scripts/ingest.mjs --zip "C:\path\deepseek_data-2026-11-14.zip"          # dry-run（默认，只算账不调用）
 *   node server/scripts/ingest.mjs --zip ... --apply --key <DeepSeek key>                # 真跑
 * 可选：--limit N（只跑前 N 个会话）--state <path>（断点续跑文件，默认与 ZIP 同目录）
 *       --model deepseek-flash --delay 1200（会话间隔 ms）--budget 12000（单会话字符预算）
 *
 * 凭据：mneme token 取 MELETE_MNEME_TOKEN（与伴随服务同一份）；DeepSeek key 取
 * DEEPSEEK_API_KEY 或 --key。dry-run 完全不联网。
 * 断点：state 文件记录已处理会话 id，重跑自动跳过；删除 state 即从头再来。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { createMemoryClient } from '../lib/memory-client.mjs'
import {
  readArchive,
  linearizeBranch,
  extractPairs,
  buildSessionText,
  buildSessionDistillMessages,
  parseSessionDistillOutput,
  SESSION_TEXT_BUDGET,
} from '../lib/ingest.mjs'

const out = (line) => process.stdout.write(`${line}\n`)
const err = (line) => process.stderr.write(`${line}\n`)
const die = (message) => {
  err(`ingest: ${message}`)
  process.exit(1)
}

// ---- 参数 ----
const args = process.argv.slice(2)
const argOf = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const has = (name) => args.includes(name)

const zipPath = argOf('--zip')
if (!zipPath || !existsSync(zipPath)) {
  die('用法：node server/scripts/ingest.mjs --zip <deepseek_data-*.zip> [--apply]')
}
const apply = has('--apply')
const limit = Number(argOf('--limit') ?? Infinity)
const budget = Number(argOf('--budget') ?? SESSION_TEXT_BUDGET)
const delayMs = Number(argOf('--delay') ?? 1200)
const statePath = resolve(argOf('--state') ?? join(dirname(resolve(zipPath)), 'melete-ingest-state.json'))
const baseUrl = argOf('--base-url') ?? process.env.MELETE_MNEME_URL ?? 'http://127.0.0.1:8790'
const token = argOf('--token') ?? process.env.MELETE_MNEME_TOKEN ?? ''
const apiOrigin = (argOf('--api-origin') ?? process.env.MELETE_API_ORIGIN ?? 'https://api.deepseek.com').replace(/\/+$/, '')
const model = argOf('--model') ?? process.env.MELETE_DISTILL_MODEL ?? 'deepseek-flash'
const apiKey = argOf('--key') ?? process.env.DEEPSEEK_API_KEY ?? ''

// ---- 读档案、建计划 ----
let archive
try {
  archive = readArchive(readFileSync(zipPath))
} catch (error) {
  die(String(error))
}
const plans = []
let totalTurns = 0
let totalChars = 0
let emptySessions = 0
for (const entry of archive.index) {
  const session = archive.sessions.get(entry.id)
  if (!session) {
    continue
  }
  const pairs = extractPairs(linearizeBranch(session))
  if (pairs.length === 0) {
    emptySessions += 1
    continue
  }
  const text = buildSessionText(pairs, budget)
  totalTurns += pairs.length
  totalChars += text.length
  plans.push({ id: entry.id, title: entry.title ?? session.title ?? '(无标题)', turns: pairs.length, chars: text.length, text })
}

out(`档案：${archive.index.length} 个会话，可蒸馏 ${plans.length} 个（空会话/残缺 ${emptySessions} 个跳过）`)
out(`轮次：${totalTurns}，采样后总计 ${totalChars} 字符（单会话预算 ${budget}）`)
if (!apply) {
  out(`预估：${plans.length} 次蒸馏调用 ≈ ${Math.round((totalChars * 0.7) / 1000)}K 输入 tokens + ${plans.length}×0.6K 输出`)
  out(`耗时：串行 + ${delayMs}ms 间隔，约 ${Math.ceil((plans.length * 4) / 60)} 分钟（每调用 ~4s）`)
  out(`预览前 10 个：`)
  for (const plan of plans.slice(0, 10)) {
    out(`  - [${plan.turns} 轮] ${plan.title}`)
  }
  out('以上为 dry-run，未联网未写库。确认无误后加 --apply --key <DeepSeek key> 真跑。')
  process.exit(0)
}

if (!token) {
  die('缺 MELETE_MNEME_TOKEN（写记忆库需要）')
}
if (!apiKey) {
  die('缺 DeepSeek key：--key 或环境变量 DEEPSEEK_API_KEY')
}

const memory = createMemoryClient({ baseUrl, token, logger: { info: out, warn: err } })
const state = existsSync(statePath) ? new Set(JSON.parse(readFileSync(statePath, 'utf8')).done ?? []) : new Set()
const saveState = (done) => writeFileSync(statePath, JSON.stringify({ done: [...done] }, null, 2))

// ---- 真跑 ----
const targets = plans.filter((plan) => !state.has(plan.id)).slice(0, Number.isFinite(limit) ? limit : plans.length)
out(`开始：${targets.length} 个会话待蒸馏（已完成断点 ${state.size} 个）`)
let written = 0
let noFacts = 0
let failed = 0
for (const [index, plan] of targets.entries()) {
  const label = `【${index + 1}/${targets.length}】${plan.title}`
  try {
    const { system, messages } = buildSessionDistillMessages(plan.text)
    const response = await fetch(`${apiOrigin}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model, system, messages, max_tokens: 1200, stream: false }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) {
      throw new Error(`上游 ${response.status}`)
    }
    const message = await response.json()
    const text = (message?.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    const parsed = parseSessionDistillOutput(text)
    if (!parsed) {
      noFacts += 1
      out(`${label} → 输出无法解析，跳过`)
    } else if (parsed.length === 0) {
      noFacts += 1
      out(`${label} → 无值得记的`)
    } else {
      const actions = []
      for (const memoryItem of parsed) {
        const saved = await memory.saveMemory(memoryItem)
        actions.push(saved.action ?? 'created')
        written += 1
      }
      out(`${label} → +${parsed.length} 条（${actions.join('/')}）：${parsed.map((item) => item.title).join('；')}`)
    }
    state.add(plan.id)
    saveState(state)
  } catch (error) {
    failed += 1
    err(`${label} → 失败：${String(error)}（继续下一个）`)
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}
out(`完成：写入 ${written} 条 / 无事实 ${noFacts} 个 / 失败 ${failed} 个；断点在 ${statePath}，重跑自动续。`)
