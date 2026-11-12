import { describe, expect, it } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import { strings } from '../src/renderer/src/strings'

/**
 * Home-screen locale tables (src/renderer/src/strings.ts): en defines the key
 * set; every other locale must cover exactly the same keys with real content.
 */

const locales = Object.keys(strings) as Array<keyof typeof strings>
const referenceKeys = Object.keys(strings.en).sort()

/** placeholders like {n}, {name}, {v} embedded in a template */
function placeholdersOf(template: string): string[] {
  return (template.match(/\{[a-zA-Z0-9]+\}/g) ?? []).sort()
}

describe('home-screen locale tables', () => {
  it('covers exactly the supported UI languages', () => {
    expect([...locales].sort()).toEqual([...LANGS].sort())
  })

  it.each(locales)('locale %s has exactly the en key set', (locale) => {
    expect(Object.keys(strings[locale]).sort()).toEqual(referenceKeys)
  })

  it.each(locales)('locale %s has no empty or whitespace-only values', (locale) => {
    const empty = Object.entries(strings[locale])
      .filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
      .map(([key]) => key)
    expect(empty).toEqual([])
  })

  it.each(locales)('locale %s keeps the en placeholder set for each key', (locale) => {
    const table = strings[locale] as Record<string, string>
    const reference = strings.en as Record<string, string>
    const mismatched = referenceKeys.filter((key) => {
      const localePlaceholders = placeholdersOf(table[key])
      const enPlaceholders = placeholdersOf(reference[key])
      // Singular-count keys ("...One") may drop the numeral entirely in
      // languages that express "one" grammatically, so a missing placeholder
      // is fine there — an extra one is not.
      if (key.endsWith('One')) {
        return localePlaceholders.some((p) => !enPlaceholders.includes(p))
      }
      return localePlaceholders.join(',') !== enPlaceholders.join(',')
    })
    expect(mismatched).toEqual([])
  })

  // Catches a locale table left as an English copy. Brand names and single
  // tokens legitimately match, so the bar is "mostly translated".
  it.each(locales.filter((locale) => locale !== 'en'))('locale %s is translated', (locale) => {
    const table = strings[locale] as Record<string, string>
    const reference = strings.en as Record<string, string>
    const identical = referenceKeys.filter((key) => table[key] === reference[key])
    expect(
      identical.length,
      `${locale} shares ${identical.length}/${referenceKeys.length} values with en`,
    ).toBeLessThan(referenceKeys.length / 3)
  })
})
