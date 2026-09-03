import { createI18n, getUiLang, htmlLang, type Params } from '@genoffice/i18n'
import { zh } from './claude-code/zh'
import { en } from './claude-code/en'
import { ja } from './claude-code/ja'
import { ko } from './claude-code/ko'
import { fr } from './claude-code/fr'
import { de } from './claude-code/de'
import { es } from './claude-code/es'
import { th } from './claude-code/th'
import { id } from './claude-code/id'
import { ru } from './claude-code/ru'
import { ar } from './claude-code/ar'
import { pt } from './claude-code/pt'
import { it } from './claude-code/it'
import { pl } from './claude-code/pl'
import { nl } from './claude-code/nl'
import { ms } from './claude-code/ms'
import { he } from './claude-code/he'
import { hi } from './claude-code/hi'
import { zhTW } from './claude-code/zh-TW'

/**
 * Messages the Claude Code bridge sends to the AI panel (main process, no
 * Electron import). Text for the model itself stays English: the skills'
 * prompts are English and the model reads them regardless of UI language.
 */
const ccMain = createI18n({
  zh,
  en,
  ja,
  ko,
  fr,
  de,
  es,
  th,
  id,
  ru,
  ar,
  pt,
  it,
  pl,
  nl,
  ms,
  he,
  hi,
  'zh-TW': zhTW,
})

export type ClaudeCodeMessageKey = keyof typeof zh

export function ccText(key: ClaudeCodeMessageKey, params?: Params): string {
  return ccMain(getUiLang(), key, params)
}

/** A wall-clock time in the UI language's locale, for "resets at …". */
export function ccLocalTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(htmlLang(getUiLang()), {
    hour: '2-digit',
    minute: '2-digit',
  })
}
