import { aiStrings } from './strings-ai'
import { appStrings } from './strings-app'
import { dialogStrings } from './strings-dialogs'

export const strings = {
  en: { ...appStrings.en, ...dialogStrings.en, ...aiStrings.en },
  sv: { ...appStrings.sv, ...dialogStrings.sv, ...aiStrings.sv },
  es: { ...appStrings.es, ...dialogStrings.es, ...aiStrings.es },
}
