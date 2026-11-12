import { createI18n, defineStrings } from '@genoffice/i18n'
import { en } from './i18n/en'
import { sv } from './i18n/sv'
import { es } from './i18n/es'

/**
 * Tod's own dictionary. It lives beside the component rather than in each
 * app's shard set: Tod says the same things everywhere, and duplicating the
 * copy into six app dictionaries would guarantee they drift apart.
 */
export const todStrings = defineStrings({
  en,
  sv,
  es,
})

export type TodStringKey = keyof typeof en

export const todText = createI18n(todStrings)
