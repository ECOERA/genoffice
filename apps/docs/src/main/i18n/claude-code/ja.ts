import type { zh } from './zh'

export const ja = {
  ccNotInstalled:
    'このコンピューターに Claude Code が見つかりません。インストールして `claude auth login` を実行してから、もう一度お試しください。',
  ccUsageLimit: 'Claude Code の利用上限に達しました。',
  ccUsageLimitResets: 'Claude Code の利用上限に達しました。{time} にリセットされます。',
  ccOverloaded: 'Claude の API が過負荷です（HTTP {status}）。Claude Code は再試行を中止しました。',
  ccNotSignedIn:
    'Claude Code にサインインしていないか、このアカウントではここで利用できません。ターミナルで `claude auth login` を実行してから、もう一度お試しください。',
  ccBilling:
    'Claude アカウントに請求上の問題があるか、保留中です。claude.ai で確認してから、もう一度お試しください。',
  ccPromptTooLong:
    '会話がモデルの上限を超えました。新しいチャットを開始してから、もう一度お試しください。',
  ccNetwork: 'Claude Code がネットワークに接続できませんでした。',
  ccTimeout: 'Claude Code がモデルの応答待ちでタイムアウトしました。',
  ccTurnLimit: 'Claude Code がこのリクエストのターン上限に達しました。',
  ccEndedWith: 'Claude Code はこのターンを「{subtype}」で終了しました。',
} satisfies Record<keyof typeof zh, string>
