import { useEffect, useState } from 'react'
import { aiModelName } from '@genoffice/ai-provider'

/**
 * The assistant's name in the chrome: the model behind the provider chosen in
 * Settings ("Claude Code", "Claude Opus 5", "Gemini 3.7 Flash"), instead of a
 * vendor wordmark. Settings live in the Home view, so the name is re-read when
 * this window regains focus.
 */
export function useAiModelName(): string {
  const [name, setName] = useState('AI')
  useEffect(() => {
    let alive = true
    const load = () => {
      void window.markdownApi
        .getAiSettings()
        .then((s) => {
          if (alive) setName(aiModelName(s))
        })
        .catch(() => {})
    }
    load()
    window.addEventListener('focus', load)
    return () => {
      alive = false
      window.removeEventListener('focus', load)
    }
  }, [])
  return name
}

/** Drop-in for the places that showed the "Genspark" wordmark. */
export function AiModelName() {
  return <>{useAiModelName()}</>
}
