/**
 * Tod's break nudge — pure state over a single work clock, persisted in
 * userData/app-settings.json under `tod`.
 *
 * The clock lives in the main process on purpose. Each app is its own
 * renderer, so six independent timers would each nag after their own 45
 * minutes and a long day spent across Docs and Sheets would never add up. The
 * main process accumulates one suite-wide total from the renderers' activity
 * pings, decides when a break is due, and tells whichever renderer is focused.
 *
 * Opening Dune Adventure resets the clock: the break was taken.
 */

export const TOD_KEY = 'tod'

/** work this long (suite-wide, active time only) before the first nudge */
export const BREAK_AFTER_MS = 45 * 60 * 1000

/**
 * A renderer pings while it is focused. A ping further apart than this means
 * the machine was asleep, the app was in the background, or the user walked
 * away — the gap is not counted as work.
 */
export const MAX_PING_GAP_MS = 90 * 1000

/** after "Not yet", stay quiet this long before asking again */
export const SNOOZE_MS = 15 * 60 * 1000

export interface TodState {
  /** active milliseconds accumulated since the last break or nudge */
  workedMs?: number
  /** ms epoch of the last activity ping, for measuring the next gap */
  lastPingAt?: number
  /** ms epoch before which no nudge may be shown (snooze) */
  quietUntil?: number
}

/** tolerate missing/corrupt settings values */
export function asTodState(value: unknown): TodState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
  return {
    workedMs: num(raw.workedMs),
    lastPingAt: num(raw.lastPingAt),
    quietUntil: num(raw.quietUntil),
  }
}

/**
 * Fold one activity ping into the clock. Only the gap since the previous ping
 * counts, and only when it is small enough to have been real working time —
 * so closing the lid for an hour adds nothing.
 */
export function withPing(state: TodState, now: number): TodState {
  const previous = state.lastPingAt
  const gap = previous === undefined ? 0 : now - previous
  const counted = gap > 0 && gap <= MAX_PING_GAP_MS ? gap : 0
  return { ...state, workedMs: (state.workedMs ?? 0) + counted, lastPingAt: now }
}

/** whether a nudge is due right now */
export function shouldNudge(state: TodState, now: number): boolean {
  if ((state.quietUntil ?? 0) > now) return false
  return (state.workedMs ?? 0) >= BREAK_AFTER_MS
}

/** whole minutes worked, for the nudge's copy */
export function workedMinutes(state: TodState): number {
  return Math.floor((state.workedMs ?? 0) / 60000)
}

/** the nudge was shown — go quiet so it cannot repeat every ping */
export function withNudged(state: TodState, now: number): TodState {
  return { ...state, quietUntil: now + SNOOZE_MS }
}

/**
 * The break was taken (Dune Adventure opened): the clock restarts from
 * nothing. Unlike the other transitions this keeps none of the old state —
 * clearing lastPingAt is what stops the first ping after the game from
 * billing the time spent playing back onto the work total, and a pending
 * snooze is moot once workedMs is zero.
 */
export function breakTaken(): TodState {
  return { workedMs: 0 }
}
