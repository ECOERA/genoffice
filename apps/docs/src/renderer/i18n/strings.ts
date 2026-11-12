import { aiStrings } from './strings-ai'
import { appStrings } from './strings-app'
import { editorStrings } from './strings-editor'
import { ribbonStrings } from './strings-ribbon'
import { tableStrings } from './strings-table'

export const strings = {
  en: {
    ...appStrings.en,
    ...ribbonStrings.en,
    ...tableStrings.en,
    ...editorStrings.en,
    ...aiStrings.en,
  },
  sv: {
    ...appStrings.sv,
    ...ribbonStrings.sv,
    ...tableStrings.sv,
    ...editorStrings.sv,
    ...aiStrings.sv,
  },
  es: {
    ...appStrings.es,
    ...ribbonStrings.es,
    ...tableStrings.es,
    ...editorStrings.es,
    ...aiStrings.es,
  },
}
