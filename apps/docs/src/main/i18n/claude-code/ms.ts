import type { zh } from './zh'

export const ms = {
  ccNotInstalled:
    'Claude Code tidak ditemui pada komputer ini. Pasangkannya, jalankan `claude auth login`, kemudian cuba lagi.',
  ccUsageLimit: 'Had penggunaan Claude Code anda telah dicapai.',
  ccUsageLimitResets:
    'Had penggunaan Claude Code anda telah dicapai. Ia ditetapkan semula pada {time}.',
  ccOverloaded: 'API Claude terlebih beban (HTTP {status}); Claude Code berhenti mencuba semula.',
  ccNotSignedIn:
    'Claude Code belum log masuk, atau akaun ini tidak boleh menggunakannya di sini. Jalankan `claude auth login` dalam terminal, kemudian cuba lagi.',
  ccBilling:
    'Akaun Claude anda mempunyai masalah pengebilan atau digantung. Semak di claude.ai, kemudian cuba lagi.',
  ccPromptTooLong:
    'Perbualan tidak lagi muat dalam model. Mulakan sembang baharu, kemudian cuba lagi.',
  ccNetwork: 'Claude Code tidak dapat mencapai rangkaian.',
  ccTimeout: 'Claude Code tamat masa menunggu model.',
  ccTurnLimit: 'Claude Code mencapai had giliran sendiri untuk permintaan ini.',
  ccEndedWith: 'Claude Code menamatkan giliran dengan "{subtype}".',
} satisfies Record<keyof typeof zh, string>
