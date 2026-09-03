import { describe, expect, it } from 'vitest'
import type { AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import type { AiStreamChunk } from '@genoffice/ai-provider'
import {
  cancelClaudeCodeSession,
  claudeCodeVersion,
  findClaudeBinary,
  runClaudeCodeTurn,
} from '../src/main/claude-code'

/**
 * These exercise the bridge against the real Claude Code CLI, so they run only
 * where one is installed and signed in — the same precondition the provider
 * itself has. Elsewhere they report the reason and skip rather than fail.
 */
const cliVersion = claudeCodeVersion()
const withCli = cliVersion ? describe : describe.skip

/** Collects chunks and resolves when the turn closes. */
function collector() {
  const chunks: AiStreamChunk[] = []
  let settle: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  return {
    chunks,
    done,
    send(chunk: AiStreamChunk) {
      chunks.push(chunk)
      if (chunk.type === 'done' || chunk.type === 'error') settle?.()
    },
    text: () =>
      chunks
        .filter((c) => c.type === 'delta')
        .map((c) => c.text ?? '')
        .join(''),
    toolCalls: () =>
      chunks.filter((c) => c.type === 'tool-call').map((c) => c.toolCall as AgentToolCall),
    error: () => chunks.find((c) => c.type === 'error')?.error,
  }
}

const ECHO_TOOL: AgentToolDef = {
  name: 'get_document_context',
  description:
    'Get the state of the open document. Call this first whenever you are asked about the document.',
  inputSchema: { type: 'object', properties: {}, required: [] },
}

const SYSTEM =
  'You are the AI assistant inside a document editor. You edit the open document through your tools. ' +
  'Never talk about files, repositories or code.'

withCli(`claude-code bridge (CLI ${cliVersion})`, () => {
  it('finds the CLI the SDK will spawn', () => {
    expect(findClaudeBinary()).toBeTruthy()
  })

  it('streams a plain answer back as delta chunks', async () => {
    const key = `test-plain-${Date.now()}`
    const sink = collector()
    await runClaudeCodeTurn({
      requestId: 'r1',
      system: SYSTEM,
      messages: [
        { role: 'user', text: 'Reply with exactly the word: SPARV. Do not call any tool.' },
      ],
      tools: [ECHO_TOOL],
      model: 'default',
      sessionKey: key,
      send: sink.send,
    })
    await sink.done
    cancelClaudeCodeSession(key)
    expect(sink.error()).toBeUndefined()
    expect(sink.text().toUpperCase()).toContain('SPARV')
  }, 180_000)

  it('parks a tool call, delivers the result, and finishes the run', async () => {
    const key = `test-tool-${Date.now()}`

    // turn 1: the model should ask for the document context
    const first = collector()
    await runClaudeCodeTurn({
      requestId: 'r1',
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          text: 'How many words does the open document have? Use get_document_context to find out, then state the number.',
        },
      ],
      tools: [ECHO_TOOL],
      model: 'default',
      sessionKey: key,
      send: first.send,
    })
    await first.done

    const calls = first.toolCalls()
    expect(calls.length).toBe(1)
    expect(calls[0]!.name).toBe('get_document_context')
    // the turn closed the way the AgentLoop expects of a tool-calling turn
    expect(first.chunks.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_use' })

    // turn 2: exactly what the renderer's AgentLoop sends back after executing it
    const second = collector()
    await runClaudeCodeTurn({
      requestId: 'r2',
      system: SYSTEM,
      messages: [
        { role: 'user', text: 'How many words does the open document have?' },
        { role: 'assistant', text: '', toolCalls: calls },
        {
          role: 'tool',
          results: [
            {
              id: calls[0]!.id,
              name: calls[0]!.name,
              output: 'Document "kvartalsrapport.docx": 12 blocks, 431 words, 2874 characters.',
            },
          ],
        },
      ],
      tools: [ECHO_TOOL],
      model: 'default',
      sessionKey: key,
      send: second.send,
    })
    await second.done
    cancelClaudeCodeSession(key)

    expect(second.error()).toBeUndefined()
    // the parked call was resolved with our result and the model used it
    expect(second.text()).toContain('431')
  }, 240_000)

  it('reports the CLI auto-compacting its own session, which then keeps working', async () => {
    // GenOffice-side compaction is off for this provider (AgentLoop `compaction: false`),
    // so the session's only compactor is the CLI's own. The smallest window the CLI
    // accepts (100K tokens) fires at ~67K, so one large tool result gets there
    // without waiting for a real long conversation. Each compaction takes the
    // CLI ~30-40s of summarizing.
    const key = `test-compact-${Date.now()}`
    const window = 100_000
    const base = {
      system: SYSTEM,
      tools: [ECHO_TOOL],
      model: 'default',
      autoCompactWindow: window,
      sessionKey: key,
    }
    // ~70k tokens of document context inside the user message, which is where the
    // skills put it (a tool result would not do: the CLI truncates MCP results at
    // 25K tokens — MAX_MCP_OUTPUT_TOKENS — so it never gets near the threshold)
    const filler = Array.from(
      { length: 2_000 },
      (_, i) => `Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog, again and again.`,
    ).join('\n')

    // turn 1: the oversized context goes in; the session is now over its threshold
    const history: Parameters<typeof runClaudeCodeTurn>[0]['messages'] = [
      {
        role: 'user',
        text: `The open document, for reference:\n${filler}\n\nReply with exactly the word: LÄST. Do not call any tool.`,
      },
    ]
    const first = collector()
    await runClaudeCodeTurn({ ...base, requestId: 'r1', messages: history, send: first.send })
    await first.done
    expect(first.error()).toBeUndefined()

    // turn 2: a fresh user message on the same session; the CLI compacts at the
    // start of this turn, and the model must still be able to park a tool call after it
    history.push({ role: 'assistant', text: first.text() })
    history.push({
      role: 'user',
      text: 'Call get_document_context once, then reply with exactly the word: KLAR.',
    })
    const second = collector()
    await runClaudeCodeTurn({ ...base, requestId: 'r2', messages: history, send: second.send })
    await second.done
    const calls = second.toolCalls()
    expect(second.error()).toBeUndefined()
    expect(calls.length).toBe(1)

    // turn 3: the parked call across the boundary resolves like any other
    history.push({ role: 'assistant', text: '', toolCalls: calls })
    history.push({
      role: 'tool',
      results: [{ id: calls[0]!.id, name: calls[0]!.name, output: 'Document: 1 block, 3 words.' }],
    })
    const third = collector()
    await runClaudeCodeTurn({ ...base, requestId: 'r3', messages: history, send: third.send })
    await third.done
    cancelClaudeCodeSession(key)

    expect(third.error()).toBeUndefined()
    expect(third.text().toUpperCase()).toContain('KLAR')

    const compactions = [...first.chunks, ...second.chunks, ...third.chunks]
      .filter((c) => c.type === 'compaction')
      .map((c) => c.compaction!)
    expect(compactions.length).toBeGreaterThan(0)
    // the boundary carries the token counts of the CLI's own compaction
    const boundary = compactions.find((c) => c.preTokens !== undefined)
    expect(boundary).toMatchObject({ trigger: 'auto' })
    expect(boundary!.preTokens!).toBeGreaterThan(boundary!.postTokens!)
    // and the summary from the PostCompact hook reaches the renderer too — on the
    // same chunk when the hook precedes the boundary (2.1.259), else on its own
    expect(compactions.some((c) => typeof c.summary === 'string' && c.summary.length > 0)).toBe(
      true,
    )
  }, 600_000)
})
