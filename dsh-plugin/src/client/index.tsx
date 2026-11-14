/**
 * 聊天模式 client 侧：slots 注册主面板页。消息流 + 输入框 + 临时通道
 * （host 侧代持 key 转发 DeepSeek），会话接线（DSH 存储 + preset 循环 + mneme）
 * 是 phase 2 —— 届时本页的数据源从临时通道换为原生会话。
 */

import { useRef, useState } from 'react'
import { CHAT_TURN_ROUTE } from '../shared/protocol.js'
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

type Turn = { role: 'user' | 'assistant'; content: string }


/** 聊天模式主面板。 */
function ChatModePage() {
  const t = (key: keyof typeof zh.ui) => zh.ui[key]
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const send = async () => {
    const text = input.trim()
    if (!text || busy) {
      return
    }
    const next: Turn[] = [...turns, { role: 'user' as const, content: text }]
    setTurns(next)
    setInput('')
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(CHAT_TURN_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      })
      const data = (await response.json().catch(() => null)) as { content?: string; error?: string } | null
      if (!response.ok || !data || typeof data.content !== 'string') {
        throw new Error(data?.error ?? `HTTP ${response.status}`)
      }
      setTurns([...next, { role: 'assistant' as const, content: data.content }])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }))
    }
  }

  return (
    <div className="melete-chat-page" style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '0 16px' }}>
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {turns.length === 0 ? (
          <div style={{ opacity: 0.65, textAlign: 'center', marginTop: 40 }}>{t('chatPageEmpty')}</div>
        ) : null}
        {turns.map((turn, index) => (
          <div
            key={index}
            style={{
              alignSelf: turn.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '78%',
              padding: '8px 12px',
              borderRadius: 12,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontSize: 14,
              lineHeight: 1.6,
              ...(turn.role === 'user'
                ? { background: 'var(--dsw-alias-brand-primary, #4b6bfb)', color: '#fff' }
                : { background: 'var(--dsw-alias-bg-base, transparent)', border: '1px solid var(--dsw-alias-border-l2, #333)' }),
            }}
          >
            {turn.content}
          </div>
        ))}
        {busy ? <div style={{ opacity: 0.6, alignSelf: 'flex-start' }}>{t('chatPageThinking')}</div> : null}
        {error ? <div style={{ color: 'var(--dsw-alias-state-error-primary, #e06055)', alignSelf: 'flex-start' }}>{error}</div> : null}
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '10px 0 14px', borderTop: '1px solid var(--dsw-alias-border-l2, #333)' }}>
        <textarea
          value={input}
          placeholder={t('chatPageInputPlaceholder')}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          rows={2}
          style={{ flex: 1, resize: 'none', borderRadius: 10, padding: '8px 10px', background: 'var(--dsw-alias-bg-base, transparent)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, #333)', fontSize: 14, fontFamily: 'inherit' }}
        />
        <button
          type="button"
          disabled={busy || !input.trim()}
          onClick={() => void send()}
          style={{ alignSelf: 'flex-end', padding: '8px 16px', borderRadius: 10, border: 'none', cursor: busy || !input.trim() ? 'default' : 'pointer', background: 'var(--dsw-alias-brand-primary, #4b6bfb)', color: '#fff', fontSize: 14 }}
        >
          {t('chatPageSend')}
        </button>
      </div>
      <div style={{ opacity: 0.55, fontSize: 12, paddingBottom: 10 }}>{t('chatPageTempNote')}</div>
    </div>
  )
}

/** DSH web 客户端入口：注册 locale 与主面板页。 */
export async function apply(ctx: ChatModeClientContext): Promise<void> {
  ctx.locale.register('chat-mode', messages)
  await ctx.slots.inject('main', () =>
    ctx.slots.register({ key: 'chat-mode', label: zh.ui.chatPageLabel }, ChatModePage),
  )
}
