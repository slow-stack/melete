/**
 * melete server：chat-demo（melete fork）的本地伴随服务。
 *
 * 三件事：
 * 1. 托管 dist 静态产物（构建时 __API_ORIGIN__ 指向本服务，见 rspack.melete.config.ts）；
 * 2. 全路径代理到 DeepSeek API（models / anthropic files / messages，SSE 原样透传）；
 * 3. 在 POST /anthropic/v1/messages 上做记忆的两头：
 *    回合前 GET mneme /context 注入 system（fail-open），
 *    回合后旁路 SSE 蒸馏 → POST mneme /memories（fire-and-forget）。
 *
 * 为什么是代理而不是改 SPA：SPA 拿不了 SQLite，记忆必须在本地有进程承接；
 * 代理让 chat-demo 源码零改动，也保证 mneme token 永不进浏览器。
 *
 * 本文件只做编排，契约细节都在 lib/（memory-client = 契约层，三条路线共用）。
 */

import { createServer } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { createMemoryClient, CONTEXT_DEFAULT_TOP_K } from './lib/memory-client.mjs'
import { lastUserText, mergeSystem } from './lib/inject.mjs'
import { buildDistillMessages, parseDistillOutput, assistantTextFromEvents } from './lib/distill.mjs'
import { createSseTap } from './lib/sse-tap.mjs'

const MESSAGES_PATH = '/anthropic/v1/messages'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

/** 逐跳头不随代理转发（RFC 7230）；accept-encoding 钉成 identity，避免 fetch 自动解压与透传头错位 */
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function proxyHeaders(reqHeaders) {
  const headers = {}
  for (const [name, value] of Object.entries(reqHeaders)) {
    const lower = name.toLowerCase()
    if (HOP_HEADERS.has(lower) || lower === 'host' || lower === 'content-length') {
      continue
    }
    headers[lower] = value
  }
  headers['accept-encoding'] = 'identity'
  return headers
}

/**
 * 创建 melete server（不监听，返回 http.Server——测试用临时端口自行 listen）。
 * config:
 *   port/host                    监听参数（bin 用；createMeleteServer 本身不看）
 *   distDir                      静态产物目录；不存在则跳过静态托管（dev 下 SPA 由 rspack serve）
 *   apiOrigin                    DeepSeek API 上游，默认 https://api.deepseek.com
 *   mnemeUrl / mnemeToken        mneme daemon 数据面与 Bearer token；token 空 = 记忆面整体关闭
 *   scopes                       { agent_scope, workspace_scope }，默认 melete/chat
 *   allowOrigins                 CORS 白名单（dev 下 SPA 与本服务跨端口）；'*' 放开
 *   distill / distillModel       回合后蒸馏开关与模型（默认 deepseek-flash——ChatModel 里轻的那档）
 *   contextTopK / contextTimeoutMs
 *   logger                       默认 console（stderr）
 */
export function createMeleteServer(config = {}) {
  const logger = config.logger ?? console
  const apiOrigin = (config.apiOrigin ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const memory = createMemoryClient({
    baseUrl: config.mnemeUrl,
    token: config.mnemeToken ?? '',
    scopes: config.scopes,
    logger,
  })
  const distDir = config.distDir ? resolve(config.distDir) : null
  const hasDist = Boolean(distDir && existsSync(distDir))
  const allowOrigins = config.allowOrigins ?? []
  const distillEnabled = config.distill ?? true
  const distillModel = config.distillModel ?? 'deepseek-flash'
  const contextTopK = config.contextTopK ?? CONTEXT_DEFAULT_TOP_K
  const contextTimeoutMs = config.contextTimeoutMs ?? 3000

  if (!memory.enabled) {
    logger.warn?.('melete: MNEME_TOKEN 未配置，记忆面关闭（聊天照常，只做纯代理）')
  }

  const corsHeaders = (origin) => {
    const matched =
      allowOrigins.includes('*') || (origin && allowOrigins.includes(origin))
        ? allowOrigins.includes('*')
          ? '*'
          : origin
        : null
    if (!matched) {
      return {}
    }
    return {
      'Access-Control-Allow-Origin': matched,
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      // 预检按请求头回显：SPA 自定义头（x-api-key / anthropic-beta）会触发 preflight
      'Access-Control-Allow-Headers':
        'authorization,content-type,accept,x-api-key,anthropic-beta',
      'Access-Control-Max-Age': '600',
    }
  }

  const respondJson = (res, status, body, extraHeaders = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders })
    res.end(JSON.stringify(body))
  }

  const serveStatic = (req, res, pathname) => {
    if (!hasDist) {
      respondJson(res, 404, { error: 'dist-not-built' })
      return
    }
    // SPA fallback：非资源路径一律回 index.html；路径归一化后必须仍在 distDir 内
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    const filePath = normalize(join(distDir, relative))
    const isAsset = filePath.startsWith(distDir) && relative !== 'index.html' && existsSync(filePath)
    const target = isAsset ? filePath : join(distDir, 'index.html')
    if (!existsSync(target)) {
      respondJson(res, 404, { error: 'not-found' })
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' })
    const stream = createReadStream(target)
    stream.on('error', () => res.end())
    stream.pipe(res)
  }

  /** 回合后蒸馏。fire-and-forget：任何一步失败只留一行日志，不触碰主响应。 */
  const distillTurn = async ({ apiKey, model, userText, events }) => {
    const assistantText = assistantTextFromEvents(events)
    if (!userText.trim() || !assistantText.trim()) {
      return
    }
    const { system, messages } = buildDistillMessages(userText, assistantText)
    const response = await fetch(`${apiOrigin}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: distillModel || model,
        system,
        messages,
        max_tokens: 600,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(`distill upstream ${response.status}`)
    }
    const message = await response.json()
    const text = (message?.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    const parsed = parseDistillOutput(text)
    if (!parsed) {
      logger.warn?.('melete: 蒸馏输出无法解析，本轮不写回')
      return
    }
    if (parsed.skip) {
      return
    }
    const saved = await memory.saveMemory(parsed.memory)
    logger.info?.(`melete: 记忆已写回（${saved.action ?? 'created'}）「${parsed.memory.title}」`)
  }

  const proxy = async (req, res, pathname, cors = {}) => {
    const upstreamUrl = `${apiOrigin}${req.url}`
    const headers = proxyHeaders(req.headers)
    const controller = new AbortController()
    res.on('close', () => controller.abort())

    const isMessages = req.method === 'POST' && pathname === MESSAGES_PATH
    let injectedBody
    let userText = ''
    if (isMessages) {
      // /messages 需要读体注入，缓冲即可（文本 + file_id 引用，体量小；附件本体走 /files 流式）
      const chunks = []
      for await (const chunk of req) {
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        injectedBody = JSON.parse(raw)
      } catch {
        injectedBody = null
      }
      if (injectedBody && typeof injectedBody === 'object') {
        userText = lastUserText(injectedBody.messages)
        try {
          const context = await memory.getContext(userText, {
            topK: contextTopK,
            signal: AbortSignal.timeout(contextTimeoutMs),
          })
          const block = memory.renderMemoryBlock(context)
          injectedBody.system = mergeSystem(injectedBody.system, block)
          if (block) {
            // 实测时的关键读数：注没注、注了几条、跑在哪个召回档（full=语义 / degraded=规则 / unknown）
            logger.info?.(`melete: 已注入 ${context.items?.length ?? 0} 条记忆（tier=${context.tier ?? "unknown"}，q=${userText.slice(0, 40)}）`)
          }
        } catch (error) {
          logger.warn?.(`melete: 记忆注入缺席，本轮按无记忆转发（${String(error)}）`)
        }
      }
      headers['content-type'] = headers['content-type'] ?? 'application/json'
    }

    let upstream
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: isMessages
          ? (injectedBody ? JSON.stringify(injectedBody) : undefined)
          : req.method === 'GET' || req.method === 'HEAD'
            ? undefined
            : Readable.toWeb(req),
        // 流式转发请求体需要半双工声明（undici）
        ...(isMessages || req.method === 'GET' || req.method === 'HEAD'
          ? {}
          : { duplex: 'half' }),
        signal: controller.signal,
      })
    } catch (error) {
      if (!res.headersSent) {
        respondJson(res, 502, { error: { type: 'upstream', message: `melete: 上游不可达（${String(error)}）` } })
      }
      return
    }

    const responseHeaders = {}
    upstream.headers.forEach((value, name) => {
      const lower = name.toLowerCase()
      if (!HOP_HEADERS.has(lower)) {
        responseHeaders[lower] = value
      }
    })

    if (!upstream.ok) {
      // 错误体原样转发（SPA 的 ApiError 解析 body.error.message）
      const text = await upstream.text().catch(() => '')
      respondJson(res, upstream.status, safeJson(text) ?? { error: { type: 'upstream', message: text || upstream.statusText } }, cors)
      return
    }

    if (!upstream.body) {
      res.writeHead(upstream.status, { ...responseHeaders, ...cors })
      res.end()
      return
    }

    const isSse = (responseHeaders['content-type'] ?? '').includes('text/event-stream')
    if (!isSse) {
      res.writeHead(upstream.status, { ...responseHeaders, ...cors })
      Readable.fromWeb(upstream.body).pipe(res)
      return
    }

    // SSE 主路：透传给客户端，字节副本喂给旁路器
    const events = []
    let stopped = false
    const tap = createSseTap((payload) => {
      if (events.length < 4000) {
        events.push(payload)
      }
      if (!stopped && payload?.type === 'message_stop') {
        stopped = true
        if (distillEnabled && memory.enabled && injectedBody) {
          distillTurn({
            apiKey: req.headers['x-api-key'] ?? bearerOf(req.headers.authorization),
            model: injectedBody.model,
            userText,
            events,
          }).catch((error) => {
            logger.warn?.(`melete: 蒸馏写回失败（${String(error)}）`)
          })
        }
      }
    })
    res.writeHead(upstream.status, { ...responseHeaders, ...cors })
    try {
      for await (const chunk of Readable.fromWeb(upstream.body)) {
        res.write(chunk)
        tap.write(chunk)
        if (!res.writableNeedDrain) {
          continue
        }
        await new Promise((resolve) => res.once('drain', resolve))
      }
      res.end()
    } catch (error) {
      logger.warn?.(`melete: SSE 透传中断（${String(error)}）`)
      res.end()
    }
  }

  return createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0]
    const cors = corsHeaders(req.headers.origin)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }

    const finish = (fn) => {
      Promise.resolve()
        .then(fn)
        .catch((error) => {
          logger.warn?.(`melete: ${String(error)}`)
          if (!res.headersSent) {
            respondJson(res, 500, { error: { type: 'melete', message: 'internal error' } }, cors)
          } else {
            res.end()
          }
        })
    }

    if (pathname === '/mneme/status') {
      finish(async () => {
        let reachable = false
        try {
          const probe = await fetch(`${memory.client.baseUrl}/health`, {
            signal: AbortSignal.timeout(2000),
          })
          reachable = probe.ok
        } catch {
          reachable = false
        }
        respondJson(res, 200, {
          mneme: { url: memory.client.baseUrl, tokenConfigured: memory.enabled, reachable },
          proxy: { apiOrigin, distillEnabled, distillModel },
        }, cors)
      })
      return
    }

    const isUpstreamPath = pathname === '/models' || pathname.startsWith('/anthropic/')
    if (isUpstreamPath) {
      finish(() => proxy(req, res, pathname, cors))
      return
    }
    finish(() => serveStatic(req, res, pathname))
  })
}

function bearerOf(authorization) {
  if (typeof authorization !== 'string') {
    return ''
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match ? match[1] : ''
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 缺省 dist 目录：仓库根的 dist/（rspack build 输出位），dev 下不存在则自动纯代理 */
export const defaultDistDir = resolve(fileURLToPath(new URL('../dist', import.meta.url)))
