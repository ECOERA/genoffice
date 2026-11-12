import { LocaleType } from '@univerjs/core'
import { describe, expect, it } from 'vitest'

import { univerLocaleFor } from '../src/renderer/univer-locales'

describe('univerLocaleFor', () => {
  it('maps every app language Univer has packs for', () => {
    expect(univerLocaleFor('es')).toBe(LocaleType.ES_ES)
  })

  it('falls back to the English boot locale otherwise', () => {
    // en needs no switch; Univer ships no Swedish pack
    for (const lang of ['en', 'sv']) {
      expect(univerLocaleFor(lang)).toBeNull()
    }
  })

  it('es packs resolve and localize the DV rule name', async () => {
    const pack = (await import('@univerjs/preset-sheets-data-validation/locales/es-ES')) as {
      default: Record<string, { list?: { name?: string } }>
    }
    expect(pack.default['sheets-data-validation']?.list?.name).toBeTruthy()
  })
})
