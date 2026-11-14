/**
 * Melete chat mode — DSH 插件入口（host 侧）。
 *
 * 聊天模式 = agent 预设（persona + 无工具行 + 快模型）+ 代管 workspace +
 * Bot 式聊天页（client 侧经 slots 注入）。记忆不在此插件内：mneme 若已安装，
 * 其宿主级钩子对 preset 会话照常生效（MemoryProvider 松耦合原则，见 README）。
 * @module @modusensus/dsh-chat-mode
 */

export { default, default as ChatModeService } from './host/index.js'
export type { ChatModeConfig, ChatModeStatus } from './host/index.js'
export { REMOTE_NAMESPACE, CHAT_TURN_PATH, CHAT_TURN_ROUTE } from './shared/protocol.js'
