import { useCallback, useEffect, useState } from 'react'
import { API_ORIGIN } from '../../services/api/client.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { loadSession, loadSessionSummaries } from '../../services/chat/db.js'
import { useSettings } from '../../services/settings.js'
import {
  MEMORY_TYPES,
  distillSession,
  planSession,
  saveMemoryDraft,
} from '../../services/memory/ingest.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './Memory.module.css'

/**
 * 设置弹窗「记忆」区：mneme 服务状态、melete 建立的记忆列表、手动添加、
 * 历史会话批量整理。所有请求都打本机伴随服务（API_ORIGIN）的 /mneme/* 代理——
 * mneme token 只在 server 进程里，前端永不直连 daemon；编辑/删除待 mneme
 * 数据面路由扩展。蒸馏逻辑在 services/memory/ingest.ts（浏览器版，与 CLI 版同构）。
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

// ---------------------------------------------------------------------------
// 整理历史会话：浏览器内按会话蒸馏 → 写回记忆库。
// 进度与运行标志放模块级——中途关掉设置页循环继续跑，重开页面进度不丢、不会双开。
// ---------------------------------------------------------------------------

const INGEST_DONE_KEY = 'melete-ingest-done'
const INGEST_DELAY_MS = 1200

type IngestItem = { sessionId: string; title: string; turns: number; chars: number }

const ingestState: {
  running: boolean
  paused: boolean
  plan: IngestItem[] | null
  progress: { done: number; total: number; written: number; title: string }
} = {
  running: false,
  paused: false,
  plan: null,
  progress: { done: 0, total: 0, written: 0, title: '' },
}

const readDoneIds = (): Set<string> =>
  new Set(JSON.parse(localStorage.getItem(INGEST_DONE_KEY) ?? '[]') as string[])

const MemoryIngest = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const [phase, setPhase] = useState<'idle' | 'estimating' | 'ready' | 'running' | 'paused' | 'done'>(
    ingestState.running ? 'running' : 'idle'
  )
  const [plan, setPlan] = useState<IngestItem[] | null>(ingestState.plan)
  const [progress, setProgress] = useState(ingestState.progress)
  const [failures, setFailures] = useState(0)

  useEffect(() => {
    // 运行中重开设置页：重新挂上模块级状态的实时读数
    if (!ingestState.running) {
      return
    }
    setPhase('running')
    setPlan(ingestState.plan)
    setProgress({ ...ingestState.progress })
  }, [])

  const estimate = async () => {
    setPhase('estimating')
    try {
      const summaries = await loadSessionSummaries()
      const items: IngestItem[] = []
      for (const summary of summaries) {
        const session = await loadSession(summary.id)
        if (!session) {
          continue
        }
        const item = planSession(session)
        if (item) {
          items.push({ sessionId: item.sessionId, title: item.title, turns: item.turns, chars: item.chars })
        }
      }
      ingestState.plan = items
      ingestState.progress = { done: 0, total: items.length, written: 0, title: '' }
      setPlan(items)
      setProgress(ingestState.progress)
      setPhase('ready')
    } catch {
      setPhase('idle')
      showToast({ key: 'memoryIngestNoSessions', type: 'error' })
    }
  }

  const run = async () => {
    if (ingestState.running || !plan || plan.length === 0) {
      return
    }
    ingestState.running = true
    ingestState.paused = false
    setPhase('running')
    setFailures(0)
    const doneIds = readDoneIds()
    const queue = plan.filter((item) => !doneIds.has(item.sessionId))
    ingestState.progress = { done: 0, total: queue.length, written: 0, title: '' }
    let written = 0
    let doneCount = 0
    let failed = 0
    for (const item of queue) {
      if (ingestState.paused) {
        break
      }
      ingestState.progress = { done: doneCount, total: queue.length, written, title: item.title }
      setProgress({ ...ingestState.progress })
      try {
        const session = await loadSession(item.sessionId)
        if (!session) {
          throw new Error('session missing')
        }
        const itemPlan = planSession(session)
        const drafts = itemPlan ? await distillSession(itemPlan.text, apiKey ?? '', 'deepseek-flash') : []
        if (drafts) {
          for (const draft of drafts) {
            await saveMemoryDraft(draft)
          }
          written += drafts.length
        }
        doneIds.add(item.sessionId)
        localStorage.setItem(INGEST_DONE_KEY, JSON.stringify([...doneIds]))
        doneCount += 1
        ingestState.progress = { done: doneCount, total: queue.length, written, title: item.title }
        setProgress({ ...ingestState.progress })
      } catch {
        failed += 1
        doneIds.add(item.sessionId)
        localStorage.setItem(INGEST_DONE_KEY, JSON.stringify([...doneIds]))
        doneCount += 1
      }
      await new Promise((resolve) => setTimeout(resolve, INGEST_DELAY_MS))
    }
    ingestState.running = false
    setFailures(failed)
    setPhase(ingestState.paused ? 'paused' : 'done')
  }

  const tokens = plan ? Math.round((plan.reduce((sum, item) => sum + item.chars, 0) * 0.7) / 1000) : 0
  const minutes = plan ? Math.ceil((plan.length * 4) / 60) : 0
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div>
      <div className={styles.label}>{t('memoryIngestTitle')}</div>
      <div className={styles.description}>{t('memoryIngestDescription')}</div>
      {!apiKey ? (
        <div className={`${styles.note} ${styles.error}`}>{t('memoryIngestNeedKey')}</div>
      ) : null}
      {phase === 'idle' ? (
        <Button variant="outlined" size="m" onClick={() => void estimate()}>
          {t('memoryIngestEstimate')}
        </Button>
      ) : null}
      {phase === 'estimating' ? <div className={styles.note}>…</div> : null}
      {plan && (phase === 'ready' || phase === 'estimating') ? (
        <div className={styles.note}>
          {t('memoryIngestEstimateResult', {
            sessions: plan.length,
            turns: plan.reduce((sum, item) => sum + item.turns, 0),
            tokens,
            minutes,
          })}
        </div>
      ) : null}
      {plan && phase === 'ready' ? (
        <Button variant="outlined" size="m" onClick={() => void run()}>
          {t('memoryIngestStart')}
        </Button>
      ) : null}
      {phase === 'running' || phase === 'paused' ? (
        <>
          <div className={styles.progress}>
            <div className={styles.progressBar} style={{ width: `${percent}%` }} />
          </div>
          <div className={styles.note}>
            {phase === 'paused'
              ? t('memoryIngestPaused', { done: progress.done, total: progress.total })
              : t('memoryIngestProgress', {
                  done: progress.done,
                  total: progress.total,
                  written: progress.written,
                  title: progress.title,
                })}
          </div>
          {phase === 'running' ? (
            <Button
              variant="outlined"
              size="s"
              onClick={() => {
                ingestState.paused = true
              }}
            >
              {t('memoryIngestPause')}
            </Button>
          ) : (
            <Button variant="outlined" size="s" onClick={() => void run()}>
              {t('memoryIngestResume')}
            </Button>
          )}
        </>
      ) : null}
      {phase === 'done' ? (
        <div className={styles.note}>
          {t('memoryIngestDone', { written: progress.written })}
          {failures > 0 ? ` · ${t('memoryIngestFailed', { count: failures })}` : ''}
        </div>
      ) : null}
      {plan && phase !== 'running' ? (
        <Button
          variant="outlined"
          size="s"
          onClick={() => {
            localStorage.removeItem(INGEST_DONE_KEY)
          }}
        >
          {t('memoryIngestReset')}
        </Button>
      ) : null}
    </div>
  )
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
              {t('memoryCompanionMissing')}
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

      <MemoryIngest />
    </div>
  )
}
