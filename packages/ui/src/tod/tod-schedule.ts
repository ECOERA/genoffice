/**
 * Tod's tip scheduling — pure logic, no React and no timers, so the rules are
 * testable without a DOM.
 *
 * Tod is the suite's Office-97-style assistant: he surfaces occasionally with
 * a canned tip, and separately relays the "time for a break" nudge the main
 * process decides (see apps/shell/src/main/tod.ts). Everything here concerns
 * only the tip rotation; the break nudge arrives over IPC and preempts it.
 */

/** the app Tod is sitting in; picks which surface-specific tips he can draw on */
export type TodSurface = 'home' | 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown'

export const TOD_SURFACES: readonly TodSurface[] = [
  'home',
  'docs',
  'sheets',
  'slides',
  'pdf',
  'markdown',
]

/** tips every surface can show */
export const GENERIC_TIP_KEYS = [
  'todTipGeneric1',
  'todTipGeneric2',
  'todTipGeneric3',
  'todTipGeneric4',
] as const

/** two tips per surface, keyed by surface name */
const SURFACE_TIP_KEYS = {
  home: ['todTipHome1', 'todTipHome2'],
  docs: ['todTipDocs1', 'todTipDocs2'],
  sheets: ['todTipSheets1', 'todTipSheets2'],
  slides: ['todTipSlides1', 'todTipSlides2'],
  pdf: ['todTipPdf1', 'todTipPdf2'],
  markdown: ['todTipMarkdown1', 'todTipMarkdown2'],
} as const

export type TodTipKey =
  (typeof GENERIC_TIP_KEYS)[number] | (typeof SURFACE_TIP_KEYS)[TodSurface][number]

/** every tip key, for the string-shard completeness test */
export const ALL_TIP_KEYS: readonly TodTipKey[] = [
  ...GENERIC_TIP_KEYS,
  ...TOD_SURFACES.flatMap((surface) => SURFACE_TIP_KEYS[surface] as readonly TodTipKey[]),
]

/** the surface's own tips first, then the shared ones */
export function tipPoolFor(surface: TodSurface): readonly TodTipKey[] {
  return [...SURFACE_TIP_KEYS[surface], ...GENERIC_TIP_KEYS]
}

/**
 * How many recently-shown tips to remember. Kept just under the smallest pool
 * (2 surface + 4 generic = 6) so there is always at least one candidate left
 * and `nextTip` never has to fall back to repeating.
 */
export const RECENT_TIP_MEMORY = 4

/**
 * Pick the next tip, avoiding the most recent ones. `random` is injectable so
 * tests are deterministic; it must return a value in [0, 1).
 */
export function nextTip(
  pool: readonly TodTipKey[],
  recent: readonly TodTipKey[],
  random: () => number = Math.random,
): TodTipKey {
  const fresh = pool.filter((key) => !recent.includes(key))
  // pool is never empty, and RECENT_TIP_MEMORY < pool.length keeps fresh non-empty;
  // the fallback only guards a caller passing a hand-built recent list.
  const candidates = fresh.length > 0 ? fresh : pool
  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length))
  return candidates[index]!
}

/** append a shown tip to the recent list, capped at RECENT_TIP_MEMORY */
export function rememberTip(recent: readonly TodTipKey[], shown: TodTipKey): readonly TodTipKey[] {
  return [...recent, shown].slice(-RECENT_TIP_MEMORY)
}

// ---- timings ----

/** Tod waits this long after a window opens before his first tip: long enough
 *  that he never lands on top of someone still finding their document. */
export const FIRST_TIP_DELAY_MS = 75_000

/** gap between tips once he has started */
export const TIP_INTERVAL_MS = 9 * 60_000

/** a tip bubble closes itself after this long if nobody reacts */
export const TIP_AUTO_HIDE_MS = 22_000

/** the break nudge stays put — it is a question, not a remark — but still
 *  gives up eventually so it cannot sit over the document forever */
export const BREAK_AUTO_HIDE_MS = 90_000
