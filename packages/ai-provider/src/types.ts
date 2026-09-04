import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'

export type AiProviderId =
  | 'genspark'
  | 'claude-code'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'openai'
  | 'kimi'
  | 'glm'
  | 'qwen'
  | 'doubao'
  | 'minimax'
  | 'xai'
  | 'mistral'
  | 'openrouter'
  | 'custom'

/** Genspark account status (gsk login state; the sole auth source for AI features) */
export interface GenSparkAccountStatus {
  loggedIn: boolean
  email?: string
}

export interface AiProviderConfig {
  apiKey: string
  model: string
  /** required for custom; for other direct providers it overrides the default endpoint (regional mirrors) */
  baseUrl?: string | undefined
}

export interface AiProviderMeta {
  id: AiProviderId
  label: string
  models: string[]
  defaultModel: string
  keyPlaceholder: string
  needsBaseUrl?: boolean
  /**
   * The provider carries no user-supplied API key: auth lives outside the
   * settings file (genspark's gsk session, claude-code's own CLI login). The
   * settings UI hides the key field and `activeProvider` must not treat an
   * empty key as a half-configured selection.
   */
  keyless?: boolean
  /**
   * The provider holds the whole conversation itself and compacts it on its
   * own (claude-code's live CLI session). The app's copy of the history is
   * UI-only for such a provider, so the renderer's AgentLoop must not run
   * its own compaction: the summarization turn would be pushed into the live
   * session as a real user message.
   */
  managesContext?: boolean
}

export interface AiSettings {
  provider: AiProviderId
  providers: Record<AiProviderId, AiProviderConfig>
  /**
   * Genspark cloud tools (web/image search via gsk, image generation, media
   * analysis). Default true; false makes tools skip the gsk backend entirely
   * (search falls back to free sources, gsk-only tools are unavailable).
   * Only meaningful while signed in — signed out, the gsk backend is
   * unavailable regardless.
   */
  gskToolsEnabled?: boolean
  /**
   * Output-token cap for ONE model turn of agent runs (default
   * DEFAULT_MAX_OUTPUT_TOKENS). Reasoning models bill their thinking against
   * this same budget, so a heavy edit turn can consume all of it and close with
   * finish_reason=length and no prose at all — raising it is the user's lever
   * (absent = the default, so pre-existing settings files keep working).
   */
  maxOutputTokens?: number | undefined
}

/** pre-provider settings shape (single OpenAI-compatible endpoint); migrated into "custom" */
export interface LegacyAiSettings {
  baseUrl?: string
  apiKey?: string
  model?: string
}

export interface AiChatRequest {
  settings: AiSettings
  system: string
  user: string
}

export interface AiChatResponse {
  ok: boolean
  content?: string
  error?: string
}

export interface AiStreamRequest {
  requestId: string
  settings: AiSettings
  system: string
  messages: AgentMessage[]
  tools?: AgentToolDef[]
  maxTokens?: number
}

/**
 * A context-owning provider (claude-code) compacted its own conversation.
 * Token counts come from the CLI's boundary event, the summary from its
 * post-compaction hook; either may be absent. Structurally identical to
 * agent-core's AgentCompaction.
 */
export interface AiCompaction {
  trigger: 'auto' | 'manual'
  preTokens?: number | undefined
  postTokens?: number | undefined
  summary?: string | undefined
}

/**
 * Tokens one model turn consumed, as the provider reports them. Carried on
 * the `done` chunk by providers that report usage (claude-code); the loop
 * sums them over a run. No money figure: for a subscription there is none
 * to show, and a list-price estimate would mislead.
 */
export interface AiUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
}

export interface AiStreamChunk {
  requestId: string
  /** 'ping' = wire-level keepalive so the renderer can tell a live stream from a dead one;
   * 'reasoning' = model thinking delta (text carries it), stored for interleaved-thinking echo;
   * 'compaction' = the provider compacted its own context (compaction carries the details) */
  type: 'delta' | 'reasoning' | 'tool-call' | 'done' | 'error' | 'ping' | 'compaction'
  text?: string
  /** complete parsed tool call (emitted once its arguments finish streaming) */
  toolCall?: AgentToolCall
  compaction?: AiCompaction
  error?: string
  /** machine-readable error cause ('timeout', exhausted 'credits', 'network' connectivity failure, 'overloaded' capacity/rate limit); lets the renderer localize the message */
  errorCode?: 'timeout' | 'credits' | 'network' | 'overloaded'
  /** normalized stop reason carried on 'done' ('max_tokens' = output cut off by the token limit) */
  stopReason?: string
  /** tokens the turn consumed, on 'done', for providers that report it */
  usage?: AiUsage
}
