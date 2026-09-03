import type { zh } from './zh'

export const it = {
  ccNotInstalled:
    'Claude Code non è stato trovato su questo computer. Installalo, esegui `claude auth login` e riprova.',
  ccUsageLimit: 'Hai raggiunto il limite di utilizzo di Claude Code.',
  ccUsageLimitResets: 'Hai raggiunto il limite di utilizzo di Claude Code. Si azzera alle {time}.',
  ccOverloaded:
    "L'API di Claude è sovraccarica (HTTP {status}); Claude Code ha smesso di riprovare.",
  ccNotSignedIn:
    "Claude Code non ha effettuato l'accesso, oppure questo account non può usarlo qui. Esegui `claude auth login` in un terminale e riprova.",
  ccBilling:
    'Il tuo account Claude ha un problema di fatturazione o è sospeso. Controllalo su claude.ai e riprova.',
  ccPromptTooLong: 'La conversazione non rientra più nel modello. Avvia una nuova chat e riprova.',
  ccNetwork: 'Claude Code non è riuscito a raggiungere la rete.',
  ccTimeout: 'Claude Code è andato in timeout in attesa del modello.',
  ccTurnLimit: 'Claude Code ha raggiunto il proprio limite di turni per questa richiesta.',
  ccEndedWith: 'Claude Code ha terminato il turno con "{subtype}".',
} satisfies Record<keyof typeof zh, string>
