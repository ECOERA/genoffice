import type { en } from './en'

export const sv = {
  ccNotInstalled:
    'Claude Code hittades inte på den här datorn. Installera det och kör `claude auth login`, och försök sedan igen.',
  ccUsageLimit: 'Din användningsgräns för Claude Code är nådd.',
  ccUsageLimitResets: 'Din användningsgräns för Claude Code är nådd. Den återställs {time}.',
  ccOverloaded: 'Claudes API är överbelastat (HTTP {status}); Claude Code gav upp försöken.',
  ccNotSignedIn:
    'Claude Code är inte inloggat, eller så kan det här kontot inte använda det här. Kör `claude auth login` i en terminal och försök igen.',
  ccBilling:
    'Ditt Claude-konto har ett faktureringsproblem eller är spärrat. Kontrollera det på claude.ai och försök igen.',
  ccPromptTooLong: 'Samtalet får inte längre plats i modellen. Starta en ny chatt och försök igen.',
  ccNetwork: 'Claude Code kunde inte nå nätverket.',
  ccTimeout: 'Claude Code fick time-out i väntan på modellen.',
  ccTurnLimit: 'Claude Code nådde sin egen turgräns för den här förfrågan.',
  ccEndedWith: 'Claude Code avslutade turen med ”{subtype}”.',
} satisfies Record<keyof typeof en, string>
