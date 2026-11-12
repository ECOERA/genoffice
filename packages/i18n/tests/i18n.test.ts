import { describe, expect, it } from 'vitest'
import {
  createI18n,
  format,
  htmlLang,
  isLang,
  LANGS,
  macShortcutsToWin,
  normalizeLang,
} from '../src/index'

describe('normalizeLang', () => {
  it('maps regional variants to the supported language', () => {
    expect(normalizeLang('en-US')).toBe('en')
    expect(normalizeLang('sv')).toBe('sv')
    expect(normalizeLang('sv-SE')).toBe('sv')
    expect(normalizeLang('SV-FI')).toBe('sv')
    expect(normalizeLang('es')).toBe('es')
    expect(normalizeLang('es-419')).toBe('es')
  })

  it('maps unsupported and missing locales to en', () => {
    expect(normalizeLang('zh-CN')).toBe('en')
    expect(normalizeLang('ja-JP')).toBe('en')
    expect(normalizeLang('de-DE')).toBe('en')
    expect(normalizeLang('')).toBe('en')
    expect(normalizeLang(undefined)).toBe('en')
    expect(normalizeLang(null)).toBe('en')
  })
})

describe('isLang', () => {
  it('accepts only supported languages', () => {
    expect(isLang('en')).toBe(true)
    expect(isLang('sv')).toBe(true)
    expect(isLang('es')).toBe(true)
    expect(isLang('zh')).toBe(false)
    expect(isLang('sv-SE')).toBe(false)
    expect(isLang(42)).toBe(false)
  })
})

describe('htmlLang', () => {
  it('maps every supported language to a BCP-47 tag', () => {
    expect(htmlLang('en')).toBe('en-US')
    expect(htmlLang('sv')).toBe('sv-SE')
    expect(htmlLang('es')).toBe('es-ES')
    for (const lang of LANGS) expect(htmlLang(lang)).toMatch(/^[a-z]{2}-[A-Z]{2}$/)
  })
})

describe('format', () => {
  it('fills placeholders and keeps unknown ones', () => {
    expect(format('Selected {n} items', { n: 3 })).toBe('Selected 3 items')
    expect(format('{a} and {b}', { a: 'x' })).toBe('x and {b}')
    expect(format('no params')).toBe('no params')
  })
})

describe('macShortcutsToWin', () => {
  it('rewrites single-modifier chords', () => {
    expect(macShortcutsToWin('Cut (⌘X)')).toBe('Cut (Ctrl+X)')
    expect(macShortcutsToWin('Save (⌘S).')).toBe('Save (Ctrl+S).')
    expect(macShortcutsToWin('⌘1')).toBe('Ctrl+1')
  })

  it('rewrites multi-modifier chords in Ctrl, Alt, Shift order', () => {
    expect(macShortcutsToWin('⇧⌘G')).toBe('Ctrl+Shift+G')
    expect(macShortcutsToWin('⌘⇧V')).toBe('Ctrl+Shift+V')
    expect(macShortcutsToWin('⌥⌘I')).toBe('Ctrl+Alt+I')
    expect(macShortcutsToWin('⌥⇧⌘Z')).toBe('Ctrl+Alt+Shift+Z')
  })

  it('dedupes command and control into one Ctrl', () => {
    expect(macShortcutsToWin('⌃⌘F')).toBe('Ctrl+F')
  })

  it('handles function keys, arrows and named keys', () => {
    expect(macShortcutsToWin('⇧F5')).toBe('Shift+F5')
    expect(macShortcutsToWin('⌘⇧↑')).toBe('Ctrl+Shift+↑')
    expect(macShortcutsToWin('⌘⇧⌫')).toBe('Ctrl+Shift+Backspace')
    expect(macShortcutsToWin('⌫')).toBe('Backspace')
    expect(macShortcutsToWin('⌦')).toBe('Delete')
    expect(macShortcutsToWin('⏎')).toBe('Enter')
    expect(macShortcutsToWin('↩')).toBe('Enter')
    expect(macShortcutsToWin('␣')).toBe('Space')
  })

  it('keeps the Ctrl side of dual-platform listings', () => {
    expect(macShortcutsToWin('⌘/Ctrl+Enter to send')).toBe('Ctrl+Enter to send')
    expect(macShortcutsToWin('⌘/Strg+Eingabetaste')).toBe('Strg+Eingabetaste')
  })

  it('rewrites modifier+word combos and bare modifiers', () => {
    expect(macShortcutsToWin('⌘+Click to follow')).toBe('Ctrl+Click to follow')
    expect(macShortcutsToWin('Hold ⌘ and click')).toBe('Hold Ctrl and click')
  })

  it('keeps a chord embedded before a word intact', () => {
    expect(macShortcutsToWin('⌘Sparar')).toBe('Ctrl+Sparar')
  })

  it('leaves strings without Mac symbols untouched', () => {
    const plain = 'Ctrl+S saves the file'
    expect(macShortcutsToWin(plain)).toBe(plain)
  })
})

describe('createI18n', () => {
  const t = createI18n({
    en: { hello: 'Hello {name}', plain: 'Files' },
    sv: { hello: 'Hej {name}', plain: 'Filer' },
    es: { hello: 'Hola {name}', plain: 'Archivos' },
  })

  it('translates per language with interpolation', () => {
    expect(t('en', 'hello', { name: 'world' })).toBe('Hello world')
    expect(t('sv', 'hello', { name: 'världen' })).toBe('Hej världen')
    expect(t('es', 'hello', { name: 'mundo' })).toBe('Hola mundo')
    expect(t('en', 'plain')).toBe('Files')
    expect(t('sv', 'plain')).toBe('Filer')
    expect(t('es', 'plain')).toBe('Archivos')
  })
})
