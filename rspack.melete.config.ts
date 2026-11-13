import { defineConfig } from '@rspack/cli'
// 复用上游构建配置，只把 API 指向改到 melete 伴随服务（server/bin.mjs 的默认监听端口）。
// 独立成文件而不改 rspack.config.ts：上游还在活跃开发，零改动 = 随时干净合并。
import { createConfig } from './rspack.config.ts'

/** melete 伴随服务地址；与 server/bin.mjs 的 MELETE_PORT 默认值一致 */
export const MELETE_SERVER_ORIGIN = 'http://127.0.0.1:8091'

// rspack CLI 约定加载 default export（与上游 rspack.config.ts 尾部同款豁免）
// eslint-disable-next-line import/no-default-export
export default defineConfig(
  createConfig({
    apiOrigin: MELETE_SERVER_ORIGIN,
  })
)
