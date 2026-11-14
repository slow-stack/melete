import { defineConfig } from 'tsdown'

// host 与 client 分开打包（官方导入插件同款分工）：host 走 lib/index.js，
// client 产物固定为 lib/client.js（dsh.client 的加载约定）。
// 依赖全部 external：cordis / dsh-* 由宿主提供，react 由 DSH web 提供。
// tsdown 约定读 default export（上游 rspack.config.ts 同款豁免）
// eslint-disable-next-line import/no-default-export
export default [
  defineConfig({
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    // dts 关闭：rolldown-plugin-dts 与 TypeScript 7（web 包同款）不兼容，
    // 运行时加载不需要 .d.ts；类型消费方恢复时换 TS5 或手写声明。
    dts: false,
  }),
  defineConfig({
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'esm',
    external: ['react'],
  }),
]
