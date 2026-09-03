import type { zh } from './zh'

export const pl = {
  ccNotInstalled:
    'Nie znaleziono Claude Code na tym komputerze. Zainstaluj go, uruchom `claude auth login` i spróbuj ponownie.',
  ccUsageLimit: 'Osiągnięto limit użycia Claude Code.',
  ccUsageLimitResets: 'Osiągnięto limit użycia Claude Code. Zostanie zresetowany o {time}.',
  ccOverloaded: 'API Claude jest przeciążone (HTTP {status}); Claude Code przestał ponawiać próby.',
  ccNotSignedIn:
    'Claude Code nie jest zalogowany lub to konto nie może go tu używać. Uruchom `claude auth login` w terminalu i spróbuj ponownie.',
  ccBilling:
    'Twoje konto Claude ma problem z rozliczeniem lub jest wstrzymane. Sprawdź je na claude.ai i spróbuj ponownie.',
  ccPromptTooLong: 'Rozmowa nie mieści się już w modelu. Rozpocznij nowy czat i spróbuj ponownie.',
  ccNetwork: 'Claude Code nie mógł połączyć się z siecią.',
  ccTimeout: 'Claude Code przekroczył limit czasu oczekiwania na model.',
  ccTurnLimit: 'Claude Code osiągnął własny limit tur dla tego żądania.',
  ccEndedWith: 'Claude Code zakończył turę wynikiem „{subtype}”.',
} satisfies Record<keyof typeof zh, string>
