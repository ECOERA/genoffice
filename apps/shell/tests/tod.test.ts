import { describe, expect, it } from 'vitest'
import {
  BREAK_AFTER_MS,
  MAX_PING_GAP_MS,
  SNOOZE_MS,
  asTodState,
  breakTaken,
  shouldNudge,
  withNudged,
  withPing,
  workedMinutes,
} from '../src/main/tod'

const T0 = 1_700_000_000_000

/**
 * Fold a run of pings `every` ms apart, the first at T0. The first ping only
 * sets the baseline, so `times` pings accumulate `times - 1` gaps.
 */
function ping(times: number, every: number, from = {}) {
  let state = from
  for (let i = 0; i < times; i++) state = withPing(state, T0 + i * every)
  return state
}

describe('asTodState', () => {
  it('tolerates junk', () => {
    expect(asTodState(null)).toEqual({})
    expect(asTodState('x')).toEqual({})
    expect(asTodState([])).toEqual({})
    expect(asTodState({ workedMs: -1, lastPingAt: 'no', quietUntil: Number.NaN })).toEqual({
      workedMs: undefined,
      lastPingAt: undefined,
      quietUntil: undefined,
    })
  })

  it('keeps valid numbers', () => {
    expect(asTodState({ workedMs: 5, lastPingAt: 7, quietUntil: 9 })).toEqual({
      workedMs: 5,
      lastPingAt: 7,
      quietUntil: 9,
    })
  })
})

describe('withPing', () => {
  it('counts nothing for the very first ping', () => {
    expect(withPing({}, T0)).toEqual({ workedMs: 0, lastPingAt: T0 })
  })

  it('accumulates the gap between consecutive pings', () => {
    const state = ping(4, 30_000) // 4 pings = 3 counted gaps
    expect(state.workedMs).toBe(90_000)
    expect(state.lastPingAt).toBe(T0 + 90_000)
  })

  it('ignores a gap longer than the ping window (sleep, background, away)', () => {
    const before = withPing({}, T0)
    const after = withPing(before, T0 + MAX_PING_GAP_MS + 1)
    expect(after.workedMs).toBe(0)
    // the clock still moves forward, so the next gap measures from here
    expect(after.lastPingAt).toBe(T0 + MAX_PING_GAP_MS + 1)
  })

  it('counts a gap exactly at the window', () => {
    const after = withPing(withPing({}, T0), T0 + MAX_PING_GAP_MS)
    expect(after.workedMs).toBe(MAX_PING_GAP_MS)
  })

  it('ignores a clock that went backwards', () => {
    const after = withPing(withPing({}, T0), T0 - 5_000)
    expect(after.workedMs).toBe(0)
  })
})

describe('shouldNudge', () => {
  it('stays quiet below the threshold', () => {
    expect(shouldNudge({ workedMs: BREAK_AFTER_MS - 1 }, T0)).toBe(false)
  })

  it('fires at the threshold', () => {
    expect(shouldNudge({ workedMs: BREAK_AFTER_MS }, T0)).toBe(true)
  })

  it('respects a snooze even past the threshold', () => {
    const snoozed = withNudged({ workedMs: BREAK_AFTER_MS }, T0)
    expect(shouldNudge(snoozed, T0 + SNOOZE_MS - 1)).toBe(false)
    expect(shouldNudge(snoozed, T0 + SNOOZE_MS + 1)).toBe(true)
  })
})

describe('workedMinutes', () => {
  it('floors to whole minutes', () => {
    expect(workedMinutes({})).toBe(0)
    expect(workedMinutes({ workedMs: 59_999 })).toBe(0)
    expect(workedMinutes({ workedMs: 45 * 60_000 })).toBe(45)
  })
})

describe('breakTaken', () => {
  it('restarts the clock, dropping the ping baseline and any snooze', () => {
    expect(breakTaken()).toEqual({ workedMs: 0 })
  })

  it('does not bill time spent in the game back onto the work total', () => {
    // 20 minutes pass inside Dune Adventure; the first ping after it must
    // count nothing, because breakTaken cleared the baseline
    const afterGame = withPing(breakTaken(), T0 + 20 * 60_000)
    expect(afterGame.workedMs).toBe(0)
  })
})

describe('the whole loop', () => {
  it('nudges after a session of real work, then goes quiet, then asks again', () => {
    // 45 minutes of 30-second pings (the first only sets the baseline)
    let state = ping(BREAK_AFTER_MS / 30_000 + 1, 30_000)
    expect(workedMinutes(state)).toBe(45)
    expect(shouldNudge(state, T0 + BREAK_AFTER_MS)).toBe(true)

    // shown and snoozed
    state = withNudged(state, T0 + BREAK_AFTER_MS)
    expect(shouldNudge(state, T0 + BREAK_AFTER_MS + 60_000)).toBe(false)

    // still working through the snooze; asks again once it lapses
    expect(shouldNudge(state, T0 + BREAK_AFTER_MS + SNOOZE_MS + 1)).toBe(true)

    // the break is taken and the cycle starts over
    state = breakTaken()
    expect(shouldNudge(state, T0 + BREAK_AFTER_MS + SNOOZE_MS + 2)).toBe(false)
  })
})
