import { useState } from 'react'
import type { OpenUrlResult } from '../shared/ipc'
import type { StringKey, TFunc } from './i18n/locale'
import { useI18n } from './i18n/locale'

/**
 * "Open from URL": paste a link to a PDF or a webpage; the main process
 * downloads it (or converts the page) and opens the result in a new tab.
 * Ported from Folio (https://github.com/Forward-Future/folio, MIT).
 */
export function OpenUrlDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = async () => {
    if (!url.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.pdfApi.openUrl({ url })
      if (result.ok) onClose()
      else if (result.reason !== 'cancelled') setError(openUrlError(result, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pdf-modal-mask" onClick={() => !busy && onClose()}>
      <div className="pdf-modal pdf-url-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pdf-modal-title">{t('openUrlTitle')}</div>
        <p className="pdf-url-hint">{t('openUrlHint')}</p>
        <input
          className={`pdf-modal-input${error ? ' invalid' : ''}`}
          value={url}
          placeholder={t('openUrlPlaceholder')}
          type="url"
          spellCheck={false}
          autoFocus
          disabled={busy}
          onChange={(e) => {
            setUrl(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void open()
            else if (e.key === 'Escape' && !busy) onClose()
          }}
        />
        {error && <p className="pdf-url-error">{error}</p>}
        <div className="pdf-modal-actions">
          {busy && <span className="pdf-url-working">{t('openUrlWorking')}</span>}
          <button className="pdf-modal-btn" disabled={busy} onClick={onClose}>
            {t('openUrlCancel')}
          </button>
          <button
            className="pdf-modal-btn primary"
            disabled={busy || !url.trim()}
            onClick={() => void open()}
          >
            {t('openUrlGo')}
          </button>
        </div>
      </div>
    </div>
  )
}

const ERROR_KEYS: Record<Exclude<OpenUrlResult, { ok: true }>['reason'], StringKey> = {
  cancelled: 'urlErrInvalid',
  invalid: 'urlErrInvalid',
  scheme: 'urlErrScheme',
  busy: 'urlErrBusy',
  'local-refused': 'urlErrLocalRefused',
  unreachable: 'urlErrUnreachable',
  'http-status': 'urlErrHttpStatus',
  redirects: 'urlErrRedirects',
  'too-large': 'urlErrTooLarge',
  'not-pdf': 'urlErrNotPdf',
  timeout: 'urlErrTimeout',
  interrupted: 'urlErrInterrupted',
  'webpage-failed': 'urlErrWebpage',
  'write-failed': 'urlErrWrite',
}

export function openUrlError(result: Exclude<OpenUrlResult, { ok: true }>, t: TFunc): string {
  const detail = 'detail' in result ? (result.detail ?? '') : ''
  return t(ERROR_KEYS[result.reason], { host: detail, status: detail })
}
