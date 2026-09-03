import type { zh } from './zh'

export const en = {
  ccNotInstalled:
    'Claude Code was not found on this machine. Install it and run `claude auth login`, then try again.',
  ccUsageLimit: 'Your Claude Code usage limit is reached.',
  ccUsageLimitResets: 'Your Claude Code usage limit is reached. It resets at {time}.',
  ccOverloaded: "Claude's API is overloaded (HTTP {status}); Claude Code gave up retrying.",
  ccNotSignedIn:
    'Claude Code is not signed in, or this account cannot use it here. Run `claude auth login` in a terminal, then try again.',
  ccBilling:
    'Your Claude account has a billing problem or is on hold. Check it at claude.ai, then try again.',
  ccPromptTooLong: 'The conversation no longer fits the model. Start a new chat and try again.',
  ccNetwork: 'Claude Code could not reach the network.',
  ccTimeout: 'Claude Code timed out waiting for the model.',
  ccTurnLimit: 'Claude Code reached its own turn limit for this request.',
  ccEndedWith: 'Claude Code ended the turn with "{subtype}".',
} satisfies Record<keyof typeof zh, string>
