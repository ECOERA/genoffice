/**
 * Back / Forward after following an internal link or an outline entry
 * (browser-style, but scoped to one document). Only jumps are recorded —
 * ordinary scrolling never adds an entry, so Back always returns to the spot
 * the reader left from.
 *
 * Locations use the ORIGINAL page index, not the visible page number, so an
 * entry survives pages being reordered or deleted around it.
 *
 * Idea and behaviour from Folio's link history (https://github.com/Forward-Future/folio,
 * MIT) — see NOTICE. Pure module (no DOM) so it is unit-tested.
 */

export interface NavLocation {
  /** Original (file) page index */
  origIdx: number
  /** Viewport-top offset within that page's row, as a fraction of the row height */
  frac: number
}

export interface NavState {
  back: boolean
  forward: boolean
}

export const MAX_NAV_ENTRIES = 100

export class NavHistory {
  private entries: NavLocation[] = []
  private index = -1

  reset(): void {
    this.entries = []
    this.index = -1
  }

  state(): NavState {
    return {
      back: this.index > 0,
      forward: this.index >= 0 && this.index < this.entries.length - 1,
    }
  }

  /** Record a jump from `from` to `to`. Drops any Forward entries, like a browser. */
  push(from: NavLocation, to: NavLocation): void {
    if (this.index < 0) {
      this.entries = [from]
      this.index = 0
    } else {
      // Refresh where the reader actually is now: they may have scrolled since the last jump
      this.entries[this.index] = from
      this.entries.splice(this.index + 1)
    }
    this.entries.push(to)
    this.index++
    if (this.entries.length > MAX_NAV_ENTRIES) {
      this.entries.shift()
      this.index--
    }
  }

  /**
   * Step back (-1) or forward (+1). `current` replaces the entry being left so
   * Forward returns to the exact scroll position. `isValid` skips entries whose
   * page no longer exists (deleted since). Returns the location to show, or null.
   */
  move(
    direction: 1 | -1,
    current: NavLocation | null,
    isValid: (loc: NavLocation) => boolean = () => true,
  ): NavLocation | null {
    let next = this.index + direction
    while (next >= 0 && next < this.entries.length && !isValid(this.entries[next]!)) {
      next += direction
    }
    if (next < 0 || next >= this.entries.length) return null
    if (current) this.entries[this.index] = current
    this.index = next
    return this.entries[next]!
  }
}
