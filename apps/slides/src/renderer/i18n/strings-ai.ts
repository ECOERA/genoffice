import { defineStrings } from '@genoffice/i18n'
import { en } from './ai/en'
import { sv } from './ai/sv'
import { es } from './ai/es'

/** User-visible copy for the ai/ panel and tool feedback (LLM prompts are not included here) */
export const aiStrings = defineStrings({
  en,
  sv,
  es,
})
