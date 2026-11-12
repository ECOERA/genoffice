import { aiStrings } from './strings-ai'
import { appStrings } from './strings-app'
import { paneStrings } from './strings-panes'
import { ribbonStrings } from './strings-ribbon'

export const strings = {
  en: { ...appStrings.en, ...ribbonStrings.en, ...paneStrings.en, ...aiStrings.en },
  sv: { ...appStrings.sv, ...ribbonStrings.sv, ...paneStrings.sv, ...aiStrings.sv },
  es: { ...appStrings.es, ...ribbonStrings.es, ...paneStrings.es, ...aiStrings.es },
}
