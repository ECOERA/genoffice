import { createI18n, getUiLang, htmlLang, type Params } from '@genoffice/i18n'
import { en } from './claude-code/en'
import { sv } from './claude-code/sv'
import { es } from './claude-code/es'

/**
 * Messages the Claude Code bridge sends to the AI panel (main process, no
 * Electron import). Text for the model itself stays English: the skills'
 * prompts are English and the model reads them regardless of UI language.
 */
const ccMain = createI18n({
  en,
  sv,
  es,
})

export type ClaudeCodeMessageKey = keyof typeof en

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
