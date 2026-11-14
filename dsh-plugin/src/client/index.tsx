/**
 * 聊天模式 client 侧：经 slots 注册主面板页（chat-demo 形态的聊天界面在此挂载）。
 * client 上下文类型先以本地最小接口表达，接真实宿主包（@deepseek-ai/dsh-client-ui-*）
 * 后换成宿主类型——与 DSH-Bot 的 apply(ctx) 注入模式同构。
 */

import { useState } from 'react'
import zh from '../../locale/zh.json'
import en from '../../locale/en.json'

interface SlotsApi {
  inject(slot: string, setup: () => unknown): Promise<void> | void
  register(config: Record<string, unknown>, component: unknown): unknown
}

interface LocaleApi {
  register(namespace: string, messages: Record<string, Record<string, string>>): Promise<void> | void
}

/** client 侧可注入能力（与 package.json 的 dsh.client.inject 清单一致）。 */
export interface ChatModeClientContext {
  slots: SlotsApi
  locale: LocaleApi
}

const messages = { en: en.ui, zh: zh.ui }

/** DSH web 客户端入口：注册 locale 与主面板页。 */
export async function apply(ctx: ChatModeClientContext): Promise<void> {
  ctx.locale.register('chat-mode', messages)
  await ctx.slots.inject('main', () =>
    ctx.slots.register({ key: 'chat-mode', label: 'Melete 聊天' }, ChatModePage),
  )
}

/** 聊天模式主面板（骨架）：preset 与会话接线在建。 */
function ChatModePage() {
  const t = (key: keyof typeof zh.ui) => zh.ui[key]
  const [note] = useState(t('chatPageSkeleton'))
  return (
    <div className="melete-chat-page">
      <h2>{t('chatPageTitle')}</h2>
      <p>{note}</p>
    </div>
  )
}
