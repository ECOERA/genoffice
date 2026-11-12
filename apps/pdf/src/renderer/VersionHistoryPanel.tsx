import { useEffect, useState } from 'react'
import type { PdfVersionChange, PdfVersionEntry } from '../shared/ipc'
import type { StringKey, TFunc } from './i18n/locale'
import { useI18n } from './i18n/locale'

/**
 * Sidebar panel listing the file's saved versions (newest first) with Open and
 * Restore. History is kept by the main process (version-history.ts). Ported
 * from Folio's VersionHistoryPanel (https://github.com/Forward-Future/folio, MIT).
 */
export function VersionHistoryPanel({
  filePath,
  refreshKey,
  dirty,
  onRestore,
}: {
  filePath: string
  /** Changes whenever the file on disk may have changed (save, page operation, restore) */
  refreshKey: unknown
  /** Unsaved edits exist: restoring discards them, so the confirmation says so */
  dirty: boolean
  /** Restore version n; resolves false when it failed (the panel then stays as it was) */
  onRestore: (n: number) => Promise<boolean>
}) {
  const { lang, t } = useI18n()
  const [versions, setVersions] = useState<PdfVersionEntry[] | null>(null)
  const [confirming, setConfirming] = useState<number | 'clear' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setConfirming(null)
    if (!filePath) return
    void window.pdfApi.listVersions(filePath).then((list) => {
      if (!cancelled) setVersions(list)
    })
    return () => {
      cancelled = true
    }
  }, [filePath, refreshKey])

  const reload = async () => setVersions(await window.pdfApi.listVersions(filePath))

  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true)
    setError(false)
    try {
      if (!(await fn())) setError(true)
    } finally {
      setBusy(false)
      setConfirming(null)
      await reload()
    }
  }

  const when = (at: number) =>
    new Date(at).toLocaleString(lang, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  if (!versions) return <div className="pdf-history" />
  const latest = versions[0]?.n
  return (
    <div className="pdf-history">
      <div className="pdf-history-title">{t('versionHistoryTitle')}</div>
      {versions.length <= 1 && <p className="pdf-history-empty">{t('versionEmpty')}</p>}
      {error && <p className="pdf-history-error">{t('versionActionFailed')}</p>}
      <ol className="pdf-history-list">
        {versions.map((v) => (
          <li key={v.n} className="pdf-history-item">
            <div className="pdf-history-head">
              <span className="pdf-history-name">
                {v.original ? t('versionOriginal') : t('versionLabel', { n: v.n })}
              </span>
              {v.n === latest && <span className="pdf-history-badge">{t('versionCurrent')}</span>}
              <span className="pdf-history-when">{when(v.createdAt)}</span>
            </div>
            {!v.original && (
              <ul className="pdf-history-changes">
                {describeChanges(v.changes, t).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
            {confirming === v.n ? (
              <div className="pdf-history-confirm">
                <span>
                  {t(dirty ? 'versionRestoreUnsaved' : 'versionRestoreConfirm', { n: v.n })}
                </span>
                <div className="pdf-history-actions">
                  <button className="pdf-history-btn" onClick={() => setConfirming(null)}>
                    {t('cancel')}
                  </button>
                  <button
                    className="pdf-history-btn primary"
                    disabled={busy}
                    onClick={() => void run(() => onRestore(v.n))}
                  >
                    {t('versionRestore')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="pdf-history-actions">
                <button
                  className="pdf-history-btn"
                  data-tip={t('versionOpenTip')}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => (await window.pdfApi.openVersion(filePath, v.n)).ok)
                  }
                >
                  {t('versionOpen')}
                </button>
                {v.n !== latest && (
                  <button
                    className="pdf-history-btn"
                    disabled={busy}
                    onClick={() => setConfirming(v.n)}
                  >
                    {t('versionRestore')}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      {versions.length > 0 && (
        <div className="pdf-history-footer">
          <p className="pdf-history-note">{t('versionLocalNote')}</p>
          {confirming === 'clear' ? (
            <div className="pdf-history-confirm">
              <span>{t('versionClearConfirm')}</span>
              <div className="pdf-history-actions">
                <button className="pdf-history-btn" onClick={() => setConfirming(null)}>
                  {t('cancel')}
                </button>
                <button
                  className="pdf-history-btn primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => (await window.pdfApi.clearVersions(filePath)).ok)
                  }
                >
                  {t('versionClear')}
                </button>
              </div>
            </div>
          ) : (
            <button className="pdf-history-link" onClick={() => setConfirming('clear')}>
              {t('versionClear')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const COUNTED: Partial<Record<PdfVersionChange['kind'], StringKey>> = {
  textInsert: 'versionChangeTextInsert',
  image: 'versionChangeImage',
  annotations: 'versionChangeAnnotations',
  forms: 'versionChangeForms',
  stamps: 'versionChangeStamps',
  pages: 'versionChangePages',
  metadata: 'versionChangeMetadata',
}

/** One display line per change; text edits show their old and new wording. */
export function describeChanges(changes: PdfVersionChange[], t: TFunc): string[] {
  if (changes.length === 0) return [t('versionNoDetails')]
  return changes.map((c) => {
    if (c.kind === 'text') {
      return t('versionChangeText', { page: c.page, before: c.before, after: c.after })
    }
    if (c.kind === 'restore') return t('versionChangeRestore', { n: c.from })
    return t(COUNTED[c.kind]!, { count: c.count })
  })
}
