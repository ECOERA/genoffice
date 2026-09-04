import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import type { AiStreamChunk } from '@genoffice/ai-provider'
import { setUiLang } from '@genoffice/i18n'
import { execSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import {
  cancelAllClaudeCodeSessions,
  cancelClaudeCodeSession,
  classifyClaudeCodeFailure,
  claudeCodeVersion,
  renderFailure,
  findClaudeBinary,
  hasClaudeCodeSession,
  interruptClaudeCodeSession,
  releaseClaudeCodeSessionWith,
  runClaudeCodeTurn,
} from '../src/main/claude-code'

/**
 * These exercise the bridge against the real Claude Code CLI, so they run only
 * where one is installed and signed in — the same precondition the provider
 * itself has. Elsewhere they report the reason and skip rather than fail.
 */
const cliVersion = claudeCodeVersion()
const withCli = cliVersion ? describe : describe.skip
/**
 * 'default' is whatever the CLI picks for the account. Override (e.g. `sonnet`)
 * when that model is unavailable — during an API overload of one model, or to
 * spend less of the allowance.
 */
const MODEL = process.env.GENOFFICE_CLAUDE_CODE_TEST_MODEL ?? 'default'

/** Collects chunks and resolves when the turn closes. */
function collector() {
  const chunks: AiStreamChunk[] = []
  let settle: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  let sawDelta: (() => void) | null = null
  const firstDelta = new Promise<void>((resolve) => {
    sawDelta = resolve
  })
  return {
    chunks,
    done,
    /** resolves once the model has started streaming text */
    firstDelta,
    send(chunk: AiStreamChunk) {
      chunks.push(chunk)
      if (chunk.type === 'delta') sawDelta?.()
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
  // a failed or timed-out test must not leave a `claude` child retrying the API
  // for minutes and holding the worker open
  afterEach(() => cancelAllClaudeCodeSessions())

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
      model: MODEL,
      sessionKey: key,
      send: sink.send,
    })
    await sink.done
    cancelClaudeCodeSession(key)
    expect(sink.error()).toBeUndefined()
    expect(sink.text().toUpperCase()).toContain('SPARV')
    // the CLI's own accounting for the turn rides on `done`
    const done = sink.chunks.at(-1)!
    expect(done.type).toBe('done')
    expect(done.usage?.inputTokens).toBeGreaterThan(0)
    expect(done.usage?.outputTokens).toBeGreaterThan(0)
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
      model: MODEL,
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
      model: MODEL,
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
      model: MODEL,
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
    expect(third.error()).toBeUndefined()
    expect(third.text().toUpperCase()).toContain('KLAR')

    // Compaction happens at a turn boundary the CLI picks; on a loaded machine
    // (the whole docs suite in parallel) it can slip past turn 2. One more cheap
    // boundary keeps the test about the reporting, not the CLI's timing.
    const seen = [...first.chunks, ...second.chunks, ...third.chunks]
    if (!seen.some((c) => c.type === 'compaction')) {
      history.push({ role: 'assistant', text: third.text() })
      history.push({
        role: 'user',
        text: 'Reply with exactly the word: SLUT. Do not call any tool.',
      })
      const fourth = collector()
      await runClaudeCodeTurn({ ...base, requestId: 'r4', messages: history, send: fourth.send })
      await fourth.done
      seen.push(...fourth.chunks)
    }
    cancelClaudeCodeSession(key)

    const compactions = seen.filter((c) => c.type === 'compaction').map((c) => c.compaction!)
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

  it('ends the session, child process included, when its owner is destroyed', async () => {
    const key = `test-owner-${Date.now()}`
    const sink = collector()
    await runClaudeCodeTurn({
      requestId: 'r1',
      system: SYSTEM,
      messages: [{ role: 'user', text: 'Reply with exactly the word: HEJ. Do not call any tool.' }],
      tools: [ECHO_TOOL],
      model: MODEL,
      sessionKey: key,
      send: sink.send,
    })
    await sink.done
    expect(hasClaudeCodeSession(key)).toBe(true)
    const before = cliProcessCount()

    // what docs-main wires up: the tab's webContents being destroyed
    let destroyed: (() => void) | null = null
    releaseClaudeCodeSessionWith(
      {
        once: (_event, listener) => {
          destroyed = listener
        },
      },
      key,
    )
    destroyed!()
    expect(hasClaudeCodeSession(key)).toBe(false)
    await waitFor(() => cliProcessCount() < before, 15_000)
    expect(cliProcessCount()).toBeLessThan(before)
  }, 120_000)

  it('interrupt stops the turn but keeps the conversation', async () => {
    const key = `test-interrupt-${Date.now()}`
    const base = { system: SYSTEM, tools: [ECHO_TOOL], model: MODEL, sessionKey: key }
    const history: Parameters<typeof runClaudeCodeTurn>[0]['messages'] = [
      {
        role: 'user',
        text: 'Remember the word PELIKAN. Reply with exactly: OK. Do not call any tool.',
      },
    ]
    const first = collector()
    await runClaudeCodeTurn({ ...base, requestId: 'r1', messages: history, send: first.send })
    await first.done
    expect(first.error()).toBeUndefined()

    // a long answer, stopped as soon as it starts streaming — the stop button
    history.push({ role: 'assistant', text: first.text() })
    history.push({
      role: 'user',
      text: 'Count from 1 to 400, one number per line. Do not call any tool.',
    })
    const second = collector()
    await runClaudeCodeTurn({ ...base, requestId: 'r2', messages: history, send: second.send })
    await second.firstDelta
    await interruptClaudeCodeSession(key)
    await second.done
    // to the renderer it is the cancel it asked for, not an error
    expect(second.error()).toBeUndefined()
    expect(second.chunks.at(-1)).toMatchObject({ type: 'done', stopReason: 'cancelled' })
    expect(second.text().length).toBeLessThan(1200)
    expect(hasClaudeCodeSession(key)).toBe(true)

    // the same session still remembers turn 1
    history.push({ role: 'assistant', text: second.text() })
    history.push({
      role: 'user',
      text: 'What word did I ask you to remember? Reply with just the word.',
    })
    const third = collector()
    await runClaudeCodeTurn({ ...base, requestId: 'r3', messages: history, send: third.send })
    await third.done
    await cancelClaudeCodeSession(key)
    expect(third.error()).toBeUndefined()
    expect(third.text().toUpperCase()).toContain('PELIKAN')
  }, 240_000)

  it('restarts the session with its history when the system prompt changes', async () => {
    const key = `test-prompt-${Date.now()}`
    const history: Parameters<typeof runClaudeCodeTurn>[0]['messages'] = [
      {
        role: 'user',
        text: 'Remember the word LAVENDEL. Reply with exactly: OK. Do not call any tool.',
      },
    ]
    const first = collector()
    await runClaudeCodeTurn({
      requestId: 'r1',
      system: SYSTEM,
      messages: history,
      tools: [ECHO_TOOL],
      model: MODEL,
      sessionKey: key,
      send: first.send,
    })
    await first.done
    expect(first.error()).toBeUndefined()

    // the AgentLoop composes the prompt per turn: here the language directive changed
    history.push({ role: 'assistant', text: first.text() })
    history.push({
      role: 'user',
      text: 'Which word did I ask you to remember? Reply with that word followed by the word "sky", nothing else. Do not call any tool.',
    })
    const second = collector()
    await runClaudeCodeTurn({
      requestId: 'r2',
      system: `${SYSTEM} ALWAYS ANSWER IN UPPERCASE LETTERS ONLY.`,
      messages: history,
      tools: [ECHO_TOOL],
      model: MODEL,
      sessionKey: key,
      send: second.send,
    })
    await second.done
    await cancelClaudeCodeSession(key)
    expect(second.error()).toBeUndefined()
    const text = second.text().trim()
    // resumed: the word from before the restart; restarted: the new prompt's rule
    expect(text).toContain('LAVENDEL')
    expect(text).toContain('SKY')
    expect(text).toBe(text.toUpperCase())
  }, 240_000)

  it('forwards an attached image as an image content block', async () => {
    const key = `test-image-${Date.now()}`
    const sink = collector()
    await runClaudeCodeTurn({
      requestId: 'r1',
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          text: 'What is the dominant color of the attached image? Reply with one lowercase word. Do not call any tool.',
          images: [{ base64: redSquarePng().toString('base64'), mime: 'image/png' }],
        },
      ],
      tools: [ECHO_TOOL],
      model: MODEL,
      sessionKey: key,
      send: sink.send,
    })
    await sink.done
    await cancelClaudeCodeSession(key)
    expect(sink.error()).toBeUndefined()
    expect(sink.text().toLowerCase()).toContain('red')
  }, 180_000)

  it('delivers a tool result larger than the CLI keeps inline, via the persisted copy', async () => {
    // Above ~50 KB the CLI would hand the model a 2 KB preview and a JSON file it
    // cannot page through. The bridge persists such a result itself as plain
    // text and lets the model Read it back whole; the marker on the last line
    // proves the entire result arrived.
    const key = `test-mcp-cap-${Date.now()}`
    const base = { system: SYSTEM, tools: [ECHO_TOOL], model: MODEL, sessionKey: key }
    const first = collector()
    await runClaudeCodeTurn({
      ...base,
      requestId: 'r1',
      messages: [
        {
          role: 'user',
          text: 'Read the open document with get_document_context. Its very last line names a code word; reply with exactly that code word.',
        },
      ],
      send: first.send,
    })
    await first.done
    const calls = first.toolCalls()
    expect(calls.length).toBe(1)

    // ~30k tokens, past the 25K default; the marker sits at the very end
    const body = Array.from(
      { length: 900 },
      (_, i) => `Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog, again and again.`,
    ).join('\n')
    const output = `${body}\nCode word: TRANBÄR`
    const second = collector()
    await runClaudeCodeTurn({
      ...base,
      requestId: 'r2',
      messages: [
        { role: 'user', text: 'Read the open document with get_document_context.' },
        { role: 'assistant', text: '', toolCalls: calls },
        { role: 'tool', results: [{ id: calls[0]!.id, name: calls[0]!.name, output }] },
      ],
      send: second.send,
    })
    await second.done
    await cancelClaudeCodeSession(key)
    expect(second.error()).toBeUndefined()
    expect(second.text().toUpperCase()).toContain('TRANBÄR')
  }, 300_000)

  it('carries tool calls issued together as one turn, and takes their results together', async () => {
    const key = `test-parallel-${Date.now()}`
    const TITLE_TOOL: AgentToolDef = {
      name: 'get_document_title',
      description: 'Get the title of the open document.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    }
    const base = { system: SYSTEM, tools: [ECHO_TOOL, TITLE_TOOL], model: MODEL, sessionKey: key }
    const first = collector()
    await runClaudeCodeTurn({
      ...base,
      requestId: 'r1',
      messages: [
        {
          role: 'user',
          text: 'Call get_document_context and get_document_title, both in the same step. Then reply with the title and the word count in one sentence.',
        },
      ],
      send: first.send,
    })
    await first.done
    const calls = first.toolCalls()
    expect(calls.map((c) => c.name).sort()).toEqual(['get_document_context', 'get_document_title'])
    // one turn: both calls before the single `done`
    expect(first.chunks.filter((c) => c.type === 'done')).toHaveLength(1)
    expect(first.chunks.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_use' })

    // the renderer executes both and returns both results in one tool message
    const second = collector()
    await runClaudeCodeTurn({
      ...base,
      requestId: 'r2',
      messages: [
        { role: 'user', text: 'Call both tools, then reply with the title and the word count.' },
        { role: 'assistant', text: '', toolCalls: calls },
        {
          role: 'tool',
          results: calls.map((call) => ({
            id: call.id,
            name: call.name,
            output:
              call.name === 'get_document_title'
                ? 'Title: Kvartalsrapport Q3'
                : 'Document: 12 blocks, 431 words, 2874 characters.',
          })),
        },
      ],
      send: second.send,
    })
    await second.done
    await cancelClaudeCodeSession(key)
    expect(second.error()).toBeUndefined()
    expect(second.text()).toContain('431')
    expect(second.text()).toMatch(/Kvartalsrapport/)
  }, 240_000)
})

/** A 64x64 solid red PNG, built without any image library. */
function redSquarePng(): Buffer {
  const width = 64
  const height = 64
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([220, 30, 30]))])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([length, typed, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe('claude-code bridge (no CLI needed)', () => {
  it('hooks a session owner once, and a hook for an unknown key is harmless', () => {
    const listeners: Array<() => void> = []
    const owner = {
      once: (_event: 'destroyed', listener: () => void) => {
        listeners.push(listener)
      },
    }
    releaseClaudeCodeSessionWith(owner, 'no-such-session')
    releaseClaudeCodeSessionWith(owner, 'no-such-session')
    expect(listeners).toHaveLength(1)
    expect(() => listeners[0]!()).not.toThrow()
    expect(hasClaudeCodeSession('no-such-session')).toBe(false)
  })

  it('interrupt and cancel are no-ops without a session', async () => {
    await expect(interruptClaudeCodeSession('no-such-session')).resolves.toBeUndefined()
    await expect(cancelClaudeCodeSession('no-such-session')).resolves.toBeUndefined()
  })

  describe('classifyClaudeCodeFailure', () => {
    // messages are localized in the main process; the assertions read the English ones
    beforeAll(() => setUiLang('en'))

    const base = {
      subtype: 'error_during_execution',
      errors: [] as string[],
      stderr: [] as string[],
      lastApiError: null,
      rateLimit: null,
      terminalReason: undefined,
    }

    it('gives a rejected subscription limit its own localized message, with the reset time', () => {
      const failure = classifyClaudeCodeFailure({
        ...base,
        rateLimit: { resetsAt: 1_788_458_400, type: 'five_hour' },
      })
      expect(failure.key).toBe('ccUsageLimitResets')
      expect(failure.params?.time).toMatch(/\d/)
      expect(failure.errorCode).toBeUndefined()
      expect(renderFailure(failure)).toMatch(/usage limit/)
      // the SDK's own class and the CLI's terminal reason say the same thing
      expect(
        classifyClaudeCodeFailure({ ...base, lastApiError: { kind: 'rate_limit', status: 429 } })
          .key,
      ).toBe('ccUsageLimit')
      expect(classifyClaudeCodeFailure({ ...base, terminalReason: 'blocking_limit' }).key).toBe(
        'ccUsageLimit',
      )
    })

    it('maps API overload and server errors to the renderer code (what a 529 storm ends as)', () => {
      const failure = classifyClaudeCodeFailure({
        ...base,
        lastApiError: { kind: 'overloaded', status: 529 },
      })
      expect(failure).toMatchObject({ key: 'ccOverloaded', errorCode: 'overloaded' })
      expect(renderFailure(failure)).toContain('529')
      expect(
        classifyClaudeCodeFailure({ ...base, lastApiError: { kind: 'server_error', status: 500 } })
          .errorCode,
      ).toBe('overloaded')
    })

    it('recognizes network and timeout signatures in the CLI output', () => {
      expect(
        classifyClaudeCodeFailure({ ...base, stderr: ['TypeError: fetch failed\n'] }),
      ).toMatchObject({ key: 'ccNetwork', errorCode: 'network' })
      expect(
        classifyClaudeCodeFailure({ ...base, errors: ['connect ECONNREFUSED 127.0.0.1:443'] })
          .errorCode,
      ).toBe('network')
      expect(
        classifyClaudeCodeFailure({ ...base, errors: ['request timed out after 60000ms'] }),
      ).toMatchObject({ key: 'ccTimeout', errorCode: 'timeout' })
    })

    it('never uses the credits code, and keeps accurate messages for account problems', () => {
      const auth = classifyClaudeCodeFailure({
        ...base,
        lastApiError: { kind: 'authentication_failed', status: 401 },
      })
      expect(auth).toMatchObject({ key: 'ccNotSignedIn' })
      expect(auth.errorCode).toBeUndefined()
      expect(renderFailure(auth)).toContain('claude auth login')
      expect(
        classifyClaudeCodeFailure({ ...base, lastApiError: { kind: 'billing_error', status: 402 } })
          .key,
      ).toBe('ccBilling')
      expect(classifyClaudeCodeFailure({ ...base, terminalReason: 'prompt_too_long' }).key).toBe(
        'ccPromptTooLong',
      )
    })

    it('falls back to the subtype with the stderr tail when nothing else is known', () => {
      const failure = classifyClaudeCodeFailure({
        ...base,
        subtype: 'error_max_turns',
        stderr: ['some detail'],
      })
      expect(failure).toMatchObject({ key: 'ccTurnLimit', detail: 'some detail' })
      expect(failure.errorCode).toBeUndefined()
      expect(renderFailure(failure)).toContain('turn limit')
      expect(renderFailure(failure)).toContain('some detail')
      expect(
        classifyClaudeCodeFailure({ ...base, subtype: 'error_during_execution' }),
      ).toMatchObject({ key: 'ccEndedWith', params: { subtype: 'error_during_execution' } })
    })
  })
})

/** Live `claude` CLI children spawned by the SDK (this test run's and any other app's). */
function cliProcessCount(): number {
  try {
    const out = execSync('pgrep -f "claude --output-format stream-json" | wc -l', {
      encoding: 'utf8',
    })
    return Number(out.trim())
  } catch {
    return 0
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !condition()) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
