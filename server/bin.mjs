/**
 * melete server 启动壳。stdout 只在就绪时打一行机器可读的
 * `melete listening on http://host:port`（对齐 dsh-mneme-serve 的约定），日志全走 stderr。
 *
 * 配置全部走环境变量（个人本地服务，不引入配置文件栈）：
 *   MELETE_PORT / MELETE_HOST          监听（默认 8091 / 127.0.0.1）
 *   MELETE_DIST                        静态目录（默认 <repo>/dist，不存在自动纯代理）
 *   MELETE_API_ORIGIN                  上游（默认 https://api.deepseek.com）
 *   MELETE_MNEME_URL                   mneme 数据面（默认 http://127.0.0.1:8790）
 *   MELETE_MNEME_TOKEN                 mneme Bearer token；空 = 记忆面关闭
 *   MELETE_ALLOW_ORIGIN                CORS 白名单逗号分隔（默认 dev 两个源）；'*' 放开
 *   MELETE_DISTILL                     蒸馏写回开关 on/off（默认 on）
 *   MELETE_DISTILL_MODEL               蒸馏模型（默认 deepseek-flash）
 *   MELETE_CONTEXT_TOPK                注入候选数（默认 5）
 *   MELETE_SCOPE_AGENT/WORKSPACE       scope 双维（默认 melete/chat）
 */
import { createMeleteServer, defaultDistDir } from './server.mjs'

const port = Number(process.env.MELETE_PORT ?? 8091)
const host = process.env.MELETE_HOST ?? '127.0.0.1'
const allowOrigins = (process.env.MELETE_ALLOW_ORIGIN ?? 'http://localhost:8090,http://127.0.0.1:8090')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

// 日志全部走 stderr：stdout 刻意只保留 listening 一行（机器可读约定）
// 用 process.stderr.write 而不是 console.*——stderr 通道本身就是这里的正业
const stderrWrite = (...args) => {
  process.stderr.write(`${args.map((arg) => String(arg)).join(' ')}\n`)
}
const stderrLogger = {
  info: stderrWrite,
  warn: stderrWrite,
}

const server = createMeleteServer({
  port,
  host,
  distDir: process.env.MELETE_DIST ?? defaultDistDir,
  apiOrigin: process.env.MELETE_API_ORIGIN,
  mnemeUrl: process.env.MELETE_MNEME_URL,
  mnemeToken: process.env.MELETE_MNEME_TOKEN ?? '',
  scopes: {
    agent_scope: process.env.MELETE_SCOPE_AGENT ?? 'melete',
    workspace_scope: process.env.MELETE_SCOPE_WORKSPACE ?? 'chat',
  },
  allowOrigins,
  distill: (process.env.MELETE_DISTILL ?? 'on') !== 'off',
  distillModel: process.env.MELETE_DISTILL_MODEL,
  contextTopK: Number(process.env.MELETE_CONTEXT_TOPK ?? 5),
  logger: stderrLogger,
})

server.listen(port, host, () => {
  // stdout 刻意只有这一行（对齐 dsh-mneme-serve：机器可读的就绪信号），日志走 stderr
  // eslint-disable-next-line no-console
  console.log(`melete listening on http://${host}:${port}`)
})

// 永久 error 监听（对齐 dsh-mneme api-standalone 的先例）：EADDRINUSE 这类套接字错误
// 不能裸崩——打一句可操作的日志后干净退出，端口被占（DSH 外部访问/daemon 二选一）是最常见成因
server.on('error', (error) => {
  // eslint-disable-next-line no-console
  console.error(`melete: 服务套接字错误（${String(error)}）——端口被占时改 MELETE_PORT 或停掉占用方`)
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
