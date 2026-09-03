import type { zh } from './zh'

export const zhTW = {
  ccNotInstalled:
    '在這台電腦上找不到 Claude Code。請先安裝並執行 `claude auth login`，然後再試一次。',
  ccUsageLimit: '已達到您的 Claude Code 使用額度。',
  ccUsageLimitResets: '已達到您的 Claude Code 使用額度，將於 {time} 重置。',
  ccOverloaded: 'Claude 的 API 目前過載（HTTP {status}），Claude Code 已停止重試。',
  ccNotSignedIn:
    'Claude Code 尚未登入，或此帳戶無法在此使用。請在終端機執行 `claude auth login`，然後再試一次。',
  ccBilling: '您的 Claude 帳戶有帳單問題或已被暫停。請在 claude.ai 檢查後再試一次。',
  ccPromptTooLong: '對話內容已超出模型可處理的長度。請開始新對話後再試一次。',
  ccNetwork: 'Claude Code 無法連線至網路。',
  ccTimeout: 'Claude Code 等待模型回應逾時。',
  ccTurnLimit: 'Claude Code 已達到此請求的自身回合上限。',
  ccEndedWith: 'Claude Code 以「{subtype}」結束了本回合。',
} satisfies Record<keyof typeof zh, string>
