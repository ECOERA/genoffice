/**
 * Tod — the suite's Office-97-style assistant.
 *
 * He stands in the bottom-right corner of every app. Two things make him
 * speak: a slow rotation of canned tips (tod-schedule.ts owns the rules), and
 * the "time for a break" nudge the main process decides and pushes in through
 * the `breakMinutes` prop. The nudge preempts a tip, because it is the one
 * thing he says that asks a question.
 *
 * The component owns no IPC: the host passes `breakMinutes` down and gets
 * `onPlayGame` / `onBreakDismissed` back, so the same component works in the
 * shell (which can open a game tab directly) and in an editor renderer (which
 * has to ask the shell over IPC).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import { TodArt, type TodPose } from './tod-art'
import { todText } from './tod-strings'
import {
  BREAK_AUTO_HIDE_MS,
  FIRST_TIP_DELAY_MS,
  TIP_AUTO_HIDE_MS,
  TIP_INTERVAL_MS,
  nextTip,
  rememberTip,
  tipPoolFor,
  type TodSurface,
  type TodTipKey,
} from './tod-schedule'

/** localStorage keys; per-renderer, so each app remembers its own answer */
const TIPS_OFF_KEY = 'duneoffice.tod.tipsOff'
const DISMISSED_KEY = 'duneoffice.tod.dismissed'

/** localStorage throws in some sandboxes; a forgotten preference is survivable */
function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) window.localStorage.setItem(key, '1')
    else window.localStorage.removeItem(key)
  } catch {
    /* private window or blocked storage: Tod just forgets between sessions */
  }
}

/** what the balloon is currently saying */
type Speech =
  | { readonly kind: 'none' }
  | { readonly kind: 'greeting' }
  | { readonly kind: 'tip'; readonly key: TodTipKey }
  | { readonly kind: 'quieted' }
  | { readonly kind: 'break'; readonly minutes: number }

export interface TodProps {
  readonly lang: Lang
  /** which app he is sitting in; picks the surface-specific tips */
  readonly surface: TodSurface
  /**
   * False parks him completely — no character, no timers. The shell passes
   * false while a document tab covers the home screen, because an editor
   * WebContentsView paints over all shell DOM and a hidden Tod would still be
   * counting down to his next tip.
   */
  readonly active?: boolean
  /**
   * Minutes worked, pushed by the main process when it decides a break is due;
   * null when no nudge is pending. A new number re-opens the nudge.
   */
  readonly breakMinutes?: number | null
  /** the user accepted: open Dune Adventure */
  readonly onPlayGame?: (() => void) | undefined
  /** the nudge was answered (either way) — the host clears/snoozes it */
  readonly onBreakDismissed?: (() => void) | undefined
}

export function Tod({
  lang,
  surface,
  active = true,
  breakMinutes = null,
  onPlayGame,
  onBreakDismissed,
}: TodProps) {
  const t = useCallback(
    (key: Parameters<typeof todText>[1], params?: Parameters<typeof todText>[2]) =>
      todText(lang, key, params),
    [lang],
  )

  const [dismissed, setDismissed] = useState(() => readFlag(DISMISSED_KEY))
  const [tipsOff, setTipsOff] = useState(() => readFlag(TIPS_OFF_KEY))
  const [speech, setSpeech] = useState<Speech>({ kind: 'none' })
  const [greeted, setGreeted] = useState(false)
  const recent = useRef<readonly TodTipKey[]>([])

  const pool = useMemo(() => tipPoolFor(surface), [surface])

  const speakTip = useCallback(() => {
    const key = nextTip(pool, recent.current)
    recent.current = rememberTip(recent.current, key)
    setSpeech({ kind: 'tip', key })
  }, [pool])

  // ---- the tip rotation ----
  // Paused whenever he is parked or the window is hidden, so a background
  // document does not burn through the rotation while nobody is looking.
  useEffect(() => {
    if (!active || dismissed || tipsOff) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = (delay: number) => {
      timer = setTimeout(() => {
        if (cancelled) return
        if (document.visibilityState === 'hidden') {
          schedule(TIP_INTERVAL_MS) // try again a full interval later
          return
        }
        if (!greeted) {
          setGreeted(true)
          setSpeech({ kind: 'greeting' })
        } else {
          speakTip()
        }
        schedule(TIP_INTERVAL_MS)
      }, delay)
    }

    schedule(greeted ? TIP_INTERVAL_MS : FIRST_TIP_DELAY_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
    // `greeted` deliberately re-arms the loop once, switching the first delay
    // to the regular interval; speakTip is stable per surface.
  }, [active, dismissed, tipsOff, greeted, speakTip])

  // ---- the break nudge, pushed from the main process ----
  useEffect(() => {
    if (breakMinutes === null || breakMinutes === undefined) return
    if (dismissed) {
      // he was sent away, but a break is a break — bring him back for it
      setDismissed(false)
      writeFlag(DISMISSED_KEY, false)
    }
    setSpeech({ kind: 'break', minutes: breakMinutes })
  }, [breakMinutes, dismissed])

  // ---- balloons close themselves ----
  useEffect(() => {
    if (speech.kind === 'none') return
    const ms = speech.kind === 'break' ? BREAK_AUTO_HIDE_MS : TIP_AUTO_HIDE_MS
    const timer = setTimeout(() => {
      if (speech.kind === 'break') onBreakDismissed?.()
      setSpeech({ kind: 'none' })
    }, ms)
    return () => clearTimeout(timer)
  }, [speech, onBreakDismissed])

  const closeSpeech = useCallback(() => {
    setSpeech((current) => {
      if (current.kind === 'break') onBreakDismissed?.()
      return { kind: 'none' }
    })
  }, [onBreakDismissed])

  // Esc closes the balloon without sending Tod away
  useEffect(() => {
    if (speech.kind === 'none') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSpeech()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [speech.kind, closeSpeech])

  const sendAway = useCallback(() => {
    if (speech.kind === 'break') onBreakDismissed?.()
    setSpeech({ kind: 'none' })
    setDismissed(true)
    writeFlag(DISMISSED_KEY, true)
  }, [speech.kind, onBreakDismissed])

  const stopTips = useCallback(() => {
    setTipsOff(true)
    writeFlag(TIPS_OFF_KEY, true)
    setSpeech({ kind: 'quieted' })
  }, [])

  const restore = useCallback(() => {
    setDismissed(false)
    writeFlag(DISMISSED_KEY, false)
  }, [])

  const poke = useCallback(() => {
    // clicking Tod asks for a tip; clicking again puts the balloon away
    if (speech.kind !== 'none') closeSpeech()
    else if (tipsOff) setSpeech({ kind: 'quieted' })
    else speakTip()
  }, [speech.kind, closeSpeech, tipsOff, speakTip])

  if (!active) return null

  if (dismissed) {
    return (
      <div className="tod-layer">
        <button
          className="tod-handle"
          onClick={restore}
          aria-label={t('todRestore')}
          title={t('todRestore')}
        >
          <TodArt size={26} grounded={false} />
        </button>
      </div>
    )
  }

  const pose: TodPose =
    speech.kind === 'break' ? 'alert' : speech.kind === 'none' ? 'idle' : 'talking'

  return (
    <div className="tod-layer">
      {speech.kind !== 'none' && (
        <Balloon
          speech={speech}
          t={t}
          onClose={closeSpeech}
          onAnotherTip={speakTip}
          onStopTips={stopTips}
          tipsOff={tipsOff}
          onPlayGame={() => {
            onBreakDismissed?.()
            setSpeech({ kind: 'none' })
            onPlayGame?.()
          }}
        />
      )}
      <button className="tod-figure" onClick={poke} aria-label={t('todAria')} title={t('todAria')}>
        <TodArt size={84} pose={pose} />
      </button>
      <button
        className="tod-dismiss"
        onClick={sendAway}
        aria-label={t('todHide')}
        title={t('todHide')}
      >
        <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M2 2l8 8M10 2L2 10"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  )
}

function Balloon({
  speech,
  t,
  onClose,
  onAnotherTip,
  onStopTips,
  onPlayGame,
  tipsOff,
}: {
  readonly speech: Exclude<Speech, { kind: 'none' }>
  readonly t: (key: Parameters<typeof todText>[1], params?: Parameters<typeof todText>[2]) => string
  readonly onClose: () => void
  readonly onAnotherTip: () => void
  readonly onStopTips: () => void
  readonly onPlayGame: () => void
  readonly tipsOff: boolean
}) {
  const isBreak = speech.kind === 'break'
  const body =
    speech.kind === 'break'
      ? t('todBreakBody', { minutes: speech.minutes })
      : speech.kind === 'tip'
        ? t(speech.key)
        : speech.kind === 'greeting'
          ? t('todGreeting')
          : t('todQuieted')

  return (
    <div
      className="tod-balloon"
      role={isBreak ? 'dialog' : 'status'}
      aria-live={isBreak ? undefined : 'polite'}
      aria-label={isBreak ? t('todBreakTitle') : t('todName')}
    >
      <button className="tod-balloon-close" onClick={onClose} aria-label={t('todClose')}>
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M2 2l8 8M10 2L2 10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <p className="tod-balloon-name">{isBreak ? t('todBreakTitle') : t('todName')}</p>
      <p className="tod-balloon-text">{body}</p>
      <div className="tod-balloon-actions">
        {isBreak ? (
          <>
            <button className="tod-btn tod-btn-primary" onClick={onPlayGame}>
              {t('todBreakGo')}
            </button>
            <button className="tod-btn" onClick={onClose}>
              {t('todBreakLater')}
            </button>
          </>
        ) : (
          <>
            <button className="tod-btn" onClick={onClose}>
              {t('todGotIt')}
            </button>
            {!tipsOff && (
              <>
                <button className="tod-btn" onClick={onAnotherTip}>
                  {t('todAnotherTip')}
                </button>
                <button className="tod-btn tod-btn-quiet" onClick={onStopTips}>
                  {t('todStopTips')}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
