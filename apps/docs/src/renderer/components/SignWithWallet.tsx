/**
 * The "Sign with MetaMask" control and the proof card behind it.
 *
 * The button follows MetaMask's own: their MetaMaskButton defaults to an
 * orange field with white text, and picks the icon from the field it sits on
 * — the white simplified fox on orange, the full-colour fox on a light
 * surface. So this file uses both official marks, each where MetaMask uses
 * it, and alters neither. `metamask-fox.svg` is their published icon from
 * metamask.io/assets; `metamask-fox-white.svg` is the simplified mark their
 * SDK button draws on an orange field. Both are brand marks, not UI chrome:
 * they keep their own colours in either theme.
 */
import { useCallback, useEffect, useState } from 'react'
import type { DocProofRecord, DocProofStatus } from '../../shared/ipc'
import { useI18n } from '../i18n/locale'
import foxColor from '../assets/metamask-fox.svg'
import foxWhite from '../assets/metamask-fox-white.svg'

/** MetaMask brand primary; the only place this value is written */
const METAMASK_ORANGE = '#FF5C16'

function ShieldCheck({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3l7 2.5v5.8c0 4.2-2.8 7.7-7 9.2-4.2-1.5-7-5-7-9.2V5.5L12 3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M8.8 12.2l2.2 2.2 4.2-4.4"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ShieldAlert({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3l7 2.5v5.8c0 4.2-2.8 7.7-7 9.2-4.2-1.5-7-5-7-9.2V5.5L12 3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M12 8.2v4.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="12" cy="15.6" r="1.1" fill="currentColor" />
    </svg>
  )
}

/** record intent -> its label string key */
const INTENT_KEY = {
  authored: 'proofIntentAuthored',
  reviewed: 'proofIntentReviewed',
  approved: 'proofIntentApproved',
  received: 'proofIntentReceived',
} as const

/** 0x1234…abcd — an address is unreadable in full and never shown that way */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

export interface SignWithWalletProps {
  /** null until the document has been saved somewhere */
  readonly filePath: string | null
}

/** the file name, for the wallet prompt and the stored record */
function nameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function SignWithWallet({ filePath }: SignWithWalletProps) {
  const { t, dateLocale } = useI18n()
  const [status, setStatus] = useState<DocProofStatus>({ state: 'unsigned' })
  const [signing, setSigning] = useState(false)
  // which operation failed, so the message can name the right one
  const [error, setError] = useState<{ kind: 'sign' | 'anchor'; text: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [intent, setIntent] = useState<DocProofRecord['intent']>('approved')
  const [supported, setSupported] = useState(false)
  const [anchoring, setAnchoring] = useState(false)

  // Re-checked on focus rather than on a save counter: that catches our own
  // saves, and also an edit made to the file by something else entirely, which
  // is exactly the case a proof exists to reveal.
  useEffect(() => {
    let alive = true
    if (!filePath) {
      setStatus({ state: 'unsigned' })
      setSupported(false)
      return
    }
    const refresh = () => {
      void window.desktop.proofCanProve(filePath).then((can) => {
        if (alive) setSupported(can)
      })
      void window.desktop.proofStatus(filePath).then((next) => {
        if (alive) setStatus(next)
      })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      window.removeEventListener('focus', refresh)
    }
  }, [filePath])

  const sign = useCallback(async () => {
    if (!filePath) return
    setSigning(true)
    setError(null)
    try {
      const result = await window.desktop.proofSign(filePath, nameOf(filePath), intent)
      if (result.ok) {
        setStatus({ state: 'valid', record: result.record })
        setOpen(true)
      } else {
        setError({ kind: 'sign', text: result.error })
      }
    } finally {
      setSigning(false)
    }
  }, [filePath, intent])

  const anchor = useCallback(async () => {
    if (!filePath) return
    setAnchoring(true)
    setError(null)
    try {
      const result = await window.desktop.proofAnchor(filePath)
      if (result.ok) {
        setStatus((prev) => ({
          ...prev,
          anchor: result.anchor,
          anchorUrl: result.url ?? undefined,
        }))
      } else {
        setError({ kind: 'anchor', text: result.error })
      }
    } finally {
      setAnchoring(false)
    }
  }, [filePath])

  const disabledReason = !filePath
    ? t('proofSignSaveFirst')
    : !supported
      ? t('proofSignUnsupported')
      : null

  const record = status.record
  const badge =
    status.state === 'valid'
      ? { cls: 'ok', icon: <ShieldCheck />, label: t('proofStateValid') }
      : status.state === 'content-changed'
        ? { cls: 'warn', icon: <ShieldAlert />, label: t('proofStateChanged') }
        : status.state === 'invalid'
          ? { cls: 'bad', icon: <ShieldAlert />, label: t('proofStateInvalid') }
          : null

  return (
    <div className="proof-group">
      {/* A ribbon button looks like the ribbon's other buttons; the branded
       * MetaMask button lives in the panel below, where the signing actually
       * happens and there is room for it at full size. */}
      <button
        className={`rb-big ${open ? 'active' : ''}`}
        disabled={disabledReason !== null}
        title={disabledReason ?? t('proofSignTip')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rb-big-icon proof-rb-icon">
          <img className="proof-fox" src={foxColor} alt="" width={20} height={20} />
          {badge && <span className={`proof-dot proof-dot-${badge.cls}`} />}
        </span>
        <span>{t('proofSignShort')}</span>
      </button>

      {open && (
        <div className="proof-card" role="dialog" aria-label={t('proofSign')}>
          {/* The heading states the document's current proof state, which is
           * the thing you came to find out. */}
          <div className="proof-card-head">
            <p className="proof-card-title">{badge?.label ?? t('proofCardTitle')}</p>
            <button
              className="proof-card-close"
              aria-label={t('proofClose')}
              title={t('proofClose')}
              onClick={() => setOpen(false)}
            >
              ✕
            </button>
          </div>

          {record && (
            <>
              <p className="proof-card-body">
                {status.state === 'valid'
                  ? t('proofValidBody')
                  : status.state === 'content-changed'
                    ? t('proofChangedBody')
                    : t('proofInvalidBody')}
              </p>
              <dl className="proof-card-facts">
                <dt>{t('proofSignerLabel')}</dt>
                <dd className="proof-mono" title={record.signer}>
                  {shortAddress(record.signer)}
                </dd>
                <dt>{t('proofSignedAsLabel')}</dt>
                <dd>{t(INTENT_KEY[record.intent])}</dd>
                <dt>{t('proofTimeLabel')}</dt>
                <dd>{new Date(record.signedAt).toLocaleString(dateLocale)}</dd>
                {status.anchor && (
                  <>
                    <dt>{t('proofAnchorLabel')}</dt>
                    <dd>
                      {new Date(status.anchor.anchoredAt).toLocaleString(dateLocale)}
                      {status.anchorUrl && (
                        <>
                          {' · '}
                          <a
                            href={status.anchorUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="proof-anchor-link"
                          >
                            {t('proofAnchorView')}
                          </a>
                        </>
                      )}
                    </dd>
                  </>
                )}
              </dl>
              {/* the signed time is a claim; a published one is not, so the
                  caveat only applies while the proof is unpublished */}
              <p className="proof-card-note">
                {status.anchor ? t('proofAnchorTimeNote') : t('proofTimeNote')}
              </p>

              {/* publishing only makes sense for a proof that currently holds */}
              {status.state === 'valid' && !status.anchor && (
                <button
                  className="proof-anchor-btn"
                  disabled={anchoring}
                  onClick={() => void anchor()}
                >
                  {anchoring ? t('proofAnchoring') : t('proofAnchorAction')}
                </button>
              )}
              {status.state === 'valid' && !status.anchor && (
                <p className="proof-card-note">{t('proofAnchorExplain')}</p>
              )}

              <hr className="proof-card-rule" />
            </>
          )}

          {/* Choosing what you are attesting to sits next to the act of
           * signing; in the ribbon it would read as a filter. */}
          <label className="proof-intent">
            <span>{t('proofIntentLabel')}</span>
            <select
              value={intent}
              disabled={signing}
              onChange={(e) => setIntent(e.target.value as DocProofRecord['intent'])}
            >
              <option value="authored">{t('proofIntentAuthored')}</option>
              <option value="reviewed">{t('proofIntentReviewed')}</option>
              <option value="approved">{t('proofIntentApproved')}</option>
              <option value="received">{t('proofIntentReceived')}</option>
            </select>
          </label>

          <button
            className="proof-sign-btn proof-sign-confirm"
            style={{ ['--mm-orange' as string]: METAMASK_ORANGE }}
            disabled={signing || disabledReason !== null}
            onClick={() => void sign()}
          >
            <span className="proof-sign-icon">
              <img src={foxWhite} alt="" width={20} height={19} />
            </span>
            <span>{signing ? t('proofSigning') : t('proofSign')}</span>
          </button>

          {error && (
            <p className="proof-error">
              {t(error.kind === 'anchor' ? 'proofAnchorFailed' : 'proofFailed', {
                error: error.text,
              })}
            </p>
          )}
          <p className="proof-card-note">{t('proofWhatIsSigned')}</p>
        </div>
      )}
    </div>
  )
}
