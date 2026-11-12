import { createRoot } from 'react-dom/client'
import { htmlLang, type Lang } from '@genoffice/i18n'
import { App } from './App'
import { LocaleProvider, setModuleLang, useI18n } from './i18n/locale'
import type { UiTheme } from '../shared/ipc'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/color-picker.css'
import '@genoffice/ui/dropdown.css'
import '@genoffice/ui/tod.css'
import './styles.css'
import './fonts/fonts.css'
import { installScreenTips, TodHost } from '@genoffice/ui'

installScreenTips()

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

/** Tod sits beside <App> rather than inside it, so a re-render of the editor
 *  never resets his tip rotation. He reads the language from LocaleProvider. */
function TodLayer() {
  const { lang } = useI18n()
  return <TodHost lang={lang} surface="docs" />
}

async function bootstrap(): Promise<void> {
  let lang: Lang = 'en'
  let theme: UiTheme = 'system'
  try {
    // per-promise catch: standalone runs have no app:get-theme handler, and
    // that rejection must not drop a resolved language
    ;[lang, theme] = await Promise.all([
      window.desktop.getLanguage().catch(() => 'en' as const),
      window.desktop.getTheme().catch(() => 'system' as const),
    ])
  } catch {
    /* dev renderer without the preload bridge */
  }
  setModuleLang(lang)
  document.documentElement.lang = htmlLang(lang)
  applyTheme(theme)
  window.desktop?.onThemeChanged(applyTheme)
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      <App />
      <TodLayer />
    </LocaleProvider>,
  )
}

void bootstrap()
