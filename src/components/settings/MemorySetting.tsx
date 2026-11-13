import { useCallback, useEffect, useState } from 'react'
import { API_ORIGIN } from '../../services/api/client.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './Memory.module.css'

/**
 * 设置弹窗「记忆」区：mneme 服务状态、melete 建立的记忆列表、手动添加。
 * 所有请求都打本机伴随服务（API_ORIGIN）的 /mneme/* 代理——mneme token 只在
 * server 进程里，前端永不直连 daemon；编辑/删除待 mneme 数据面路由扩展。
 */

type MemoryStatus = {
  mneme: { url: string; tokenConfigured: boolean; reachable: boolean }
  proxy: { apiOrigin: string; distillEnabled: boolean; distillModel: string }
}

type MemoryItem = {
  id: string
  type: string
  title: string
  content: string
  importance: number
}

type MemoryList = { items: MemoryItem[]; total: number }

const MEMORY_TYPES = ['preference', 'decision', 'summary', 'pattern', 'history'] as const

type MemoryType = (typeof MEMORY_TYPES)[number]

const TYPE_LABEL_KEYS: Record<MemoryType, TranslationKey> = {
  preference: 'memoryTypePreference',
  decision: 'memoryTypeDecision',
  summary: 'memoryTypeSummary',
  pattern: 'memoryTypePattern',
  history: 'memoryTypeHistory',
}

/** 错误响应里挑可读信息；daemon 的错误形状是 { error: string | { message } } */
const errorText = async (response: Response): Promise<string> => {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && 'error' in body) {
      const value = (body as { error: unknown }).error
      if (typeof value === 'string') {
        return value
      }
      if (value && typeof value === 'object' && 'message' in value) {
        return String((value as { message: unknown }).message)
      }
    }
  } catch {
    // 无错误体时用状态码
  }
  return String(response.status)
}

export const MemorySetting = () => {
  const t = useTranslate()
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [statusFailed, setStatusFailed] = useState(false)
  const [list, setList] = useState<MemoryList | null>(null)
  const [listError, setListError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [type, setType] = useState<MemoryType>('summary')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [importance, setImportance] = useState('3')

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const statusResponse = await fetch(`${API_ORIGIN}/mneme/status`)
      setStatusFailed(!statusResponse.ok)
      setStatus(statusResponse.ok ? ((await statusResponse.json()) as MemoryStatus) : null)
      const listResponse = await fetch(`${API_ORIGIN}/mneme/memories?source=melete&limit=50`)
      setListError(!listResponse.ok)
      setList(listResponse.ok ? ((await listResponse.json()) as MemoryList) : null)
    } catch {
      setStatusFailed(true)
      setListError(true)
    } finally {
      setLoaded(true)
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = async () => {
    if (!title.trim() || !content.trim() || busy) {
      return
    }
    setBusy(true)
    try {
      const response = await fetch(`${API_ORIGIN}/mneme/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, title: title.trim(), content: content.trim(), importance: Number(importance) }),
      })
      if (!response.ok) {
        throw new Error(await errorText(response))
      }
      setTitle('')
      setContent('')
      showToast({ key: 'memoryAddSuccess' })
      await refresh()
    } catch {
      showToast({ key: 'memoryAddFailed', type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const typeOptions = MEMORY_TYPES.map((value) => ({ value, label: t(TYPE_LABEL_KEYS[value]) }))

  return (
    <div className={styles.memories}>
      <div>
        <div className={styles.label}>{t('memoryStatusTitle')}</div>
        <div className={styles.description}>
          {statusFailed || !status ? (
            <>
              <span className={`${styles.statusDot} ${styles.statusDotBad}`} />
              {t('memoryStatusUnreachable')}
            </>
          ) : (
            <>
              <span
                className={`${styles.statusDot} ${status.mneme.reachable ? styles.statusDotOk : styles.statusDotBad}`}
              />
              {status.mneme.reachable
                ? t('memoryStatusOk', {
                    url: status.mneme.url,
                    distill: t(status.proxy.distillEnabled ? 'memoryStatusOn' : 'memoryStatusOff'),
                  })
                : t('memoryStatusUnreachable')}
              {' · '}
              {t(status.mneme.tokenConfigured ? 'memoryTokenConfigured' : 'memoryTokenMissing')}
            </>
          )}
          {' '}
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            {t('memoryRefresh')}
          </button>
        </div>
      </div>

      <div>
        <div className={styles.label}>{t('memoryListTitle')}</div>
        <div className={styles.description}>{t('memoryListDescription')}</div>
        <div className={styles.list}>
          {!loaded ? null : listError || !list ? (
            <div className={`${styles.empty} ${styles.error}`}>{t('memoryLoadFailed')}</div>
          ) : list.items.length === 0 ? (
            <div className={styles.empty}>{t('memoryEmpty')}</div>
          ) : (
            list.items.map((item) => (
              <div key={item.id} className={styles.listItem}>
                <div className={styles.listTitleRow}>
                  <span className={styles.listTitle}>{item.title}</span>
                  <span className={styles.listType}>
                    {TYPE_LABEL_KEYS[item.type as MemoryType]
                      ? t(TYPE_LABEL_KEYS[item.type as MemoryType])
                      : item.type}
                  </span>
                </div>
                <div className={styles.listContent}>{item.content}</div>
              </div>
            ))
          )}
        </div>
        <div className={styles.note}>{t('memoryEditNote')}</div>
      </div>

      <div>
        <div className={styles.label}>{t('memoryAddTitle')}</div>
        <div className={styles.form}>
          <div className={styles.formRow}>
            <select
              className={styles.select}
              aria-label={t('memoryTypeLabel')}
              value={type}
              onChange={(event) => setType(event.target.value as MemoryType)}
            >
              {typeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className={styles.select}
              aria-label={t('memoryImportanceLabel')}
              value={importance}
              onChange={(event) => setImportance(event.target.value)}
            >
              {[5, 4, 3, 2, 1].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <input
            className={styles.input}
            placeholder={t('memoryTitleLabel')}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            className={styles.textarea}
            placeholder={t('memoryContentLabel')}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
          <div className={styles.actions}>
            <Button
              variant="outlined"
              size="m"
              disabled={busy || !title.trim() || !content.trim()}
              onClick={() => void save()}
            >
              {t('memoryAddSubmit')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
