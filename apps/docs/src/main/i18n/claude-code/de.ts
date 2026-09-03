import type { zh } from './zh'

export const de = {
  ccNotInstalled:
    'Claude Code wurde auf diesem Rechner nicht gefunden. Installieren Sie es, führen Sie `claude auth login` aus und versuchen Sie es erneut.',
  ccUsageLimit: 'Ihr Claude-Code-Nutzungslimit ist erreicht.',
  ccUsageLimitResets:
    'Ihr Claude-Code-Nutzungslimit ist erreicht. Es wird um {time} zurückgesetzt.',
  ccOverloaded:
    'Die Claude-API ist überlastet (HTTP {status}); Claude Code hat die Wiederholungsversuche aufgegeben.',
  ccNotSignedIn:
    'Claude Code ist nicht angemeldet, oder dieses Konto kann es hier nicht verwenden. Führen Sie `claude auth login` in einem Terminal aus und versuchen Sie es erneut.',
  ccBilling:
    'Ihr Claude-Konto hat ein Abrechnungsproblem oder ist gesperrt. Prüfen Sie es auf claude.ai und versuchen Sie es erneut.',
  ccPromptTooLong:
    'Die Unterhaltung passt nicht mehr in das Modell. Beginnen Sie einen neuen Chat und versuchen Sie es erneut.',
  ccNetwork: 'Claude Code konnte das Netzwerk nicht erreichen.',
  ccTimeout: 'Claude Code hat beim Warten auf das Modell das Zeitlimit überschritten.',
  ccTurnLimit: 'Claude Code hat sein eigenes Rundenlimit für diese Anfrage erreicht.',
  ccEndedWith: 'Claude Code hat die Runde mit „{subtype}“ beendet.',
} satisfies Record<keyof typeof zh, string>
