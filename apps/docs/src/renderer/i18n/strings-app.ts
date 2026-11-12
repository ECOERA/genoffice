import { defineStrings } from '@genoffice/i18n'
import { en } from './app/en'
import { sv } from './app/sv'
import { es } from './app/es'

/** Strings for App.tsx / SettingsModal / non-Ribbon components (keys use the app prefix to mark the area) */
export const appStrings = defineStrings({
  en,
  sv,
  es,
})
