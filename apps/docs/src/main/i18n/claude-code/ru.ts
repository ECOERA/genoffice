import type { zh } from './zh'

export const ru = {
  ccNotInstalled:
    'Claude Code не найден на этом компьютере. Установите его, выполните `claude auth login` и повторите попытку.',
  ccUsageLimit: 'Достигнут лимит использования Claude Code.',
  ccUsageLimitResets: 'Достигнут лимит использования Claude Code. Он сбросится в {time}.',
  ccOverloaded: 'API Claude перегружен (HTTP {status}); Claude Code прекратил повторные попытки.',
  ccNotSignedIn:
    'Claude Code не выполнил вход, или этот аккаунт не может использоваться здесь. Выполните `claude auth login` в терминале и повторите попытку.',
  ccBilling:
    'У вашего аккаунта Claude проблема с оплатой, или он приостановлен. Проверьте на claude.ai и повторите попытку.',
  ccPromptTooLong:
    'Разговор больше не помещается в контекст модели. Начните новый чат и повторите попытку.',
  ccNetwork: 'Claude Code не смог подключиться к сети.',
  ccTimeout: 'Claude Code превысил время ожидания ответа модели.',
  ccTurnLimit: 'Claude Code достиг собственного лимита ходов для этого запроса.',
  ccEndedWith: 'Claude Code завершил ход с результатом «{subtype}».',
} satisfies Record<keyof typeof zh, string>
