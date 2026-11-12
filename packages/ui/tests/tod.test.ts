import { describe, expect, it } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import {
  ALL_TIP_KEYS,
  GENERIC_TIP_KEYS,
  RECENT_TIP_MEMORY,
  TOD_SURFACES,
  nextTip,
  rememberTip,
  tipPoolFor,
  type TodTipKey,
} from '../src/tod/tod-schedule'
import { todStrings, todText } from '../src/tod/tod-strings'
import { BODY_LENGTH, BODY_RING_COUNT, SAND_TOP, bodyRings } from '../src/tod/tod-geometry'

describe('tip pools', () => {
  it('gives every surface its own two tips plus the shared four', () => {
    for (const surface of TOD_SURFACES) {
      const pool = tipPoolFor(surface)
      expect(pool).toHaveLength(2 + GENERIC_TIP_KEYS.length)
      expect(new Set(pool).size).toBe(pool.length)
      for (const generic of GENERIC_TIP_KEYS) expect(pool).toContain(generic)
    }
  })

  it('never shares a surface-specific tip between surfaces', () => {
    const own = TOD_SURFACES.map((s) =>
      tipPoolFor(s).filter((k) => !(GENERIC_TIP_KEYS as readonly string[]).includes(k)),
    )
    const all = own.flat()
    expect(new Set(all).size).toBe(all.length)
  })

  it('leaves room to avoid repeats: memory is smaller than the smallest pool', () => {
    for (const surface of TOD_SURFACES) {
      expect(RECENT_TIP_MEMORY).toBeLessThan(tipPoolFor(surface).length)
    }
  })
})

describe('nextTip', () => {
  it('skips the recently shown ones', () => {
    const pool = tipPoolFor('docs')
    const recent = pool.slice(0, 3)
    for (let i = 0; i < 20; i++) {
      expect(recent).not.toContain(nextTip(pool, recent, () => i / 20))
    }
  })

  it('is deterministic given a random source', () => {
    const pool = tipPoolFor('sheets')
    expect(nextTip(pool, [], () => 0)).toBe(pool[0])
    expect(nextTip(pool, [], () => 0.999999)).toBe(pool[pool.length - 1])
  })

  it('never repeats within a rotation of the full pool', () => {
    const pool = tipPoolFor('home')
    let recent: readonly TodTipKey[] = []
    const seen: TodTipKey[] = []
    for (let i = 0; i < RECENT_TIP_MEMORY + 1; i++) {
      const key = nextTip(pool, recent, () => 0)
      expect(seen).not.toContain(key)
      seen.push(key)
      recent = rememberTip(recent, key)
    }
  })

  it('falls back to the pool rather than throwing when everything is recent', () => {
    const pool = tipPoolFor('pdf')
    expect(pool).toContain(nextTip(pool, pool, () => 0.5))
  })
})

describe('rememberTip', () => {
  it('keeps only the most recent entries', () => {
    let recent: readonly TodTipKey[] = []
    for (const key of ALL_TIP_KEYS) recent = rememberTip(recent, key)
    expect(recent).toHaveLength(RECENT_TIP_MEMORY)
    expect(recent).toEqual(ALL_TIP_KEYS.slice(-RECENT_TIP_MEMORY))
  })
})

describe('Tod strings', () => {
  const dicts = todStrings as unknown as Record<string, Record<string, string>>
  const keys = Object.keys(dicts.en!).sort()

  it('covers exactly the supported languages', () => {
    expect(Object.keys(dicts).sort()).toEqual([...LANGS].sort())
  })

  it.each([...LANGS])('locale %s has exactly the en key set, with content', (lang) => {
    expect(Object.keys(dicts[lang]!).sort()).toEqual(keys)
    for (const [key, value] of Object.entries(dicts[lang]!)) {
      expect(value.trim().length, `${lang}.${key} is empty`).toBeGreaterThan(0)
    }
  })

  it.each([...LANGS])('locale %s keeps the en placeholders', (lang) => {
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
    for (const key of keys) {
      expect(placeholders(dicts[lang]![key]!), `${lang}.${key}`).toEqual(
        placeholders(dicts.en![key]!),
      )
    }
  })

  it('defines a string for every tip key', () => {
    for (const key of ALL_TIP_KEYS) expect(keys).toContain(key)
  })

  it('translates, with interpolation', () => {
    expect(todText('en', 'todBreakBody', { minutes: 45 })).toContain('45')
    expect(todText('sv', 'todBreakBody', { minutes: 45 })).toContain('45')
    expect(todText('sv', 'todName')).toBe('Tod')
    // the break nudge is the whole point; make sure it is really translated
    expect(todText('sv', 'todBreakGo')).not.toBe(todText('en', 'todBreakGo'))
  })
})

describe('body geometry', () => {
  it('samples a path of plausible length', () => {
    // the wire runs the height of the artwork a few times over
    expect(BODY_LENGTH).toBeGreaterThan(200)
    expect(BODY_LENGTH).toBeLessThan(600)
  })

  it('spaces the segment rings evenly along the wire', () => {
    const rings = bodyRings(BODY_RING_COUNT)
    expect(rings).toHaveLength(BODY_RING_COUNT)
    for (const [x1, y1, x2, y2] of rings) {
      // every ring is a chord across the wire, so its width is the full span
      const width = Math.hypot(x2 - x1, y2 - y1)
      expect(width).toBeCloseTo(11.8, 1)
      // and it sits inside the artwork's viewBox
      for (const v of [x1, x2]) expect(v).toBeGreaterThan(14)
      for (const v of [y1, y2]) expect(v).toBeGreaterThan(4)
    }
  })

  it('keeps all but the submerged coil above the sand line', () => {
    const rings = bodyRings(BODY_RING_COUNT)
    const submerged = rings.filter(([, y1, , y2]) => Math.max(y1, y2) > SAND_TOP)
    // the bottom bend dips into the mound on purpose — that is what makes him
    // read as rising out of the sand — but only that bend may go under.
    expect(submerged.length).toBeGreaterThan(0)
    expect(submerged.length).toBeLessThanOrEqual(3)
    // and nothing reaches the bottom of the mound, where it would vanish
    for (const [, y1, , y2] of rings) expect(Math.max(y1, y2)).toBeLessThan(SAND_TOP + 14)
  })
})
