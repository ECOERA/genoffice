/** Claude Code bridge messages shown in the AI panel (main process); zh defines the key set */
export const zh = {
  ccNotInstalled: '此电脑上找不到 Claude Code。请先安装并运行 `claude auth login`，然后重试。',
  ccUsageLimit: '已达到您的 Claude Code 使用额度。',
  ccUsageLimitResets: '已达到您的 Claude Code 使用额度，将于 {time} 重置。',
  ccOverloaded: 'Claude 的 API 当前过载（HTTP {status}），Claude Code 已停止重试。',
  ccNotSignedIn:
    'Claude Code 未登录，或此账户无法在此使用。请在终端运行 `claude auth login`，然后重试。',
  ccBilling: '您的 Claude 账户存在账单问题或已被暂停。请在 claude.ai 检查后重试。',
  ccPromptTooLong: '对话内容已超出模型可处理的长度。请开始新对话后重试。',
  ccNetwork: 'Claude Code 无法连接网络。',
  ccTimeout: 'Claude Code 等待模型响应超时。',
  ccTurnLimit: 'Claude Code 已达到本次请求的自身轮次上限。',
  ccEndedWith: 'Claude Code 以“{subtype}”结束了本轮。',
}
