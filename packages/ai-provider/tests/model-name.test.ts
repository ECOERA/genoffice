import { describe, expect, it } from 'vitest'
import { aiModelName, prettyModelName, type AiSettings } from '../src'

const settings = (provider: string, model: string, apiKey = 'k'): AiSettings =>
  ({
    provider,
    providers: { [provider]: { apiKey, model } },
  }) as unknown as AiSettings

describe('prettyModelName', () => {
  it('turns ids into product names', () => {
    expect(prettyModelName('claude-opus-5')).toBe('Claude Opus 5')
    expect(prettyModelName('claude-sonnet-4-5-20250929')).toBe('Claude Sonnet 4 5')
    expect(prettyModelName('gpt-5.6-terra')).toBe('GPT-5.6 Terra')
    expect(prettyModelName('gemini-3.7-flash')).toBe('Gemini 3.7 Flash')
    expect(prettyModelName('deepseek-v4-pro')).toBe('DeepSeek V4 Pro')
    expect(prettyModelName('glm-5.3')).toBe('GLM 5.3')
    expect(prettyModelName('kimi-k3')).toBe('Kimi K3')
  })
})

describe('aiModelName', () => {
  it('names the assistant after the active model', () => {
    expect(aiModelName(null)).toBe('AI')
    expect(aiModelName(settings('claude-code', 'default', ''))).toBe('Claude Code')
    expect(aiModelName(settings('claude-code', 'opus', ''))).toBe('Claude Opus')
    expect(aiModelName(settings('anthropic', 'claude-opus-5'))).toBe('Claude Opus 5')
    expect(aiModelName(settings('gemini', 'gemini-3.7-flash'))).toBe('Gemini 3.7 Flash')
    expect(aiModelName(settings('genspark', 'claude-opus-4-7', ''))).toBe(
      'Genspark · Claude Opus 4 7',
    )
    // a half-configured API provider falls back to genspark, like the requests do
    expect(aiModelName(settings('openai', 'gpt-5.6-terra', ''))).toMatch(/^Genspark/)
  })
})
