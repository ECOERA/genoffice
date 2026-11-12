import { describe, expect, it } from 'vitest'
import { MAX_NAV_ENTRIES, NavHistory } from '../src/renderer/nav-history'

const at = (origIdx: number, frac = 0) => ({ origIdx, frac })

describe('NavHistory', () => {
  it('starts with nothing to go back or forward to', () => {
    expect(new NavHistory().state()).toEqual({ back: false, forward: false })
  })

  it('goes back to where the reader left from, then forward again', () => {
    const h = new NavHistory()
    h.push(at(0, 0.5), at(7))
    expect(h.state()).toEqual({ back: true, forward: false })
    expect(h.move(-1, at(7, 0.2))).toEqual(at(0, 0.5))
    expect(h.state()).toEqual({ back: false, forward: true })
    // Forward returns to the exact spot the reader was at when pressing Back
    expect(h.move(1, at(0, 0.5))).toEqual(at(7, 0.2))
  })

  it('a new jump after going back drops the forward entries', () => {
    const h = new NavHistory()
    h.push(at(0), at(5))
    h.push(at(5), at(9))
    h.move(-1, at(9))
    h.push(at(5, 0.3), at(2))
    expect(h.state()).toEqual({ back: true, forward: false })
    expect(h.move(-1, at(2))).toEqual(at(5, 0.3))
    expect(h.move(-1, at(5))).toEqual(at(0))
    expect(h.move(-1, at(0))).toBeNull()
  })

  it('skips entries whose page has been deleted', () => {
    const h = new NavHistory()
    h.push(at(0), at(3))
    h.push(at(3), at(6))
    expect(h.move(-1, at(6), (loc) => loc.origIdx !== 3)).toEqual(at(0))
  })

  it('caps the number of entries', () => {
    const h = new NavHistory()
    for (let i = 0; i < MAX_NAV_ENTRIES + 20; i++) h.push(at(i), at(i + 1))
    let steps = 0
    while (h.move(-1, null)) steps++
    expect(steps).toBe(MAX_NAV_ENTRIES - 1)
  })
})
