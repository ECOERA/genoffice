/**
 * Tod wired to the desktop bridge.
 *
 * `Tod` itself is deliberately IPC-free so it can be rendered in a test or a
 * story. This wrapper is what the apps actually mount: it reports activity to
 * the main process, relays the break nudge back down, and routes "ride the
 * worm" to the shell's game tab.
 *
 * Outside Electron (a bare `vite dev` renderer) `window.todBridge` is absent;
 * Tod then still shows his tips and simply never gets a break nudge.
 */
import React, { useCallback, useEffect, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import { Tod } from './Tod'
import type { TodSurface } from './tod-schedule'

/** must stay well under MAX_PING_GAP_MS in apps/shell/src/main/tod.ts */
const PING_INTERVAL_MS = 30_000

interface TodBridgeApi {
  ping(): void
  onBreakDue(handler: (minutes: number) => void): () => void
  playGame(): void
}

declare global {
  interface Window {
    todBridge?: TodBridgeApi
  }
}

export interface TodHostProps {
  readonly lang: Lang
  readonly surface: TodSurface
  /** false parks Tod entirely (the shell passes false while a document tab covers home) */
  readonly active?: boolean
}

export function TodHost({ lang, surface, active = true }: TodHostProps) {
  const [breakMinutes, setBreakMinutes] = useState<number | null>(null)

  // Report activity while this window is both parked-in and visible. A hidden
  // or inactive window must not bill time, or a deck left open overnight would
  // "work" all night.
  useEffect(() => {
    const bridge = window.todBridge
    if (!bridge || !active) return
    const tick = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) bridge.ping()
    }
    tick()
    const timer = setInterval(tick, PING_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [active])

  useEffect(() => window.todBridge?.onBreakDue(setBreakMinutes), [])

  const playGame = useCallback(() => {
    setBreakMinutes(null)
    window.todBridge?.playGame()
  }, [])

  // Declining needs no IPC: the main process snoozed the nudge the moment it
  // sent it, so dropping the local state is the whole of "not yet".
  const dismiss = useCallback(() => setBreakMinutes(null), [])

  return (
    <Tod
      lang={lang}
      surface={surface}
      active={active}
      breakMinutes={breakMinutes}
      onPlayGame={playGame}
      onBreakDismissed={dismiss}
    />
  )
}
