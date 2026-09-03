import type { zh } from './zh'

export const id = {
  ccNotInstalled:
    'Claude Code tidak ditemukan di komputer ini. Instal, jalankan `claude auth login`, lalu coba lagi.',
  ccUsageLimit: 'Batas penggunaan Claude Code Anda telah tercapai.',
  ccUsageLimitResets: 'Batas penggunaan Claude Code Anda telah tercapai. Akan direset pada {time}.',
  ccOverloaded:
    'API Claude sedang kelebihan beban (HTTP {status}); Claude Code berhenti mencoba ulang.',
  ccNotSignedIn:
    'Claude Code belum masuk, atau akun ini tidak dapat menggunakannya di sini. Jalankan `claude auth login` di terminal, lalu coba lagi.',
  ccBilling:
    'Akun Claude Anda memiliki masalah penagihan atau sedang ditangguhkan. Periksa di claude.ai, lalu coba lagi.',
  ccPromptTooLong: 'Percakapan sudah melebihi kapasitas model. Mulai obrolan baru, lalu coba lagi.',
  ccNetwork: 'Claude Code tidak dapat terhubung ke jaringan.',
  ccTimeout: 'Claude Code kehabisan waktu menunggu model.',
  ccTurnLimit: 'Claude Code mencapai batas giliran internalnya untuk permintaan ini.',
  ccEndedWith: 'Claude Code mengakhiri giliran dengan "{subtype}".',
} satisfies Record<keyof typeof zh, string>
