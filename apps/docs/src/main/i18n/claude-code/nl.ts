import type { zh } from './zh'

export const nl = {
  ccNotInstalled:
    'Claude Code is niet gevonden op deze computer. Installeer het, voer `claude auth login` uit en probeer het opnieuw.',
  ccUsageLimit: 'Je gebruikslimiet van Claude Code is bereikt.',
  ccUsageLimitResets: 'Je gebruikslimiet van Claude Code is bereikt. Deze wordt om {time} gereset.',
  ccOverloaded:
    'De API van Claude is overbelast (HTTP {status}); Claude Code is gestopt met opnieuw proberen.',
  ccNotSignedIn:
    'Claude Code is niet aangemeld, of dit account kan het hier niet gebruiken. Voer `claude auth login` uit in een terminal en probeer het opnieuw.',
  ccBilling:
    'Je Claude-account heeft een factureringsprobleem of is geblokkeerd. Controleer het op claude.ai en probeer het opnieuw.',
  ccPromptTooLong:
    'Het gesprek past niet meer in het model. Begin een nieuwe chat en probeer het opnieuw.',
  ccNetwork: 'Claude Code kon het netwerk niet bereiken.',
  ccTimeout: 'Claude Code kreeg een time-out tijdens het wachten op het model.',
  ccTurnLimit: 'Claude Code heeft zijn eigen beurtlimiet voor dit verzoek bereikt.',
  ccEndedWith: 'Claude Code heeft de beurt beëindigd met "{subtype}".',
} satisfies Record<keyof typeof zh, string>
