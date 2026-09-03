/**
 * Claude Code provider bridge (prototype).
 *
 * Every other provider in `packages/ai-provider` is a naked model behind an
 * HTTP endpoint: the renderer's AgentLoop owns the conversation, asks for one
 * turn, executes the tools the model asked for, and comes back. Claude Code is
 * not a model — it is a second agent harness, with its own loop, its own
 * context management and its own credentials. Two harnesses cannot both drive.
 *
 * The bridge resolves that without changing a line of renderer code, by making
 * Claude Code's loop *look* like a sequence of ordinary turns:
 *
 *   1. A turn arrives on `ai:stream`. If no session exists for this window we
 *      start one `query()` with a pushable input stream and keep it open for
 *      the life of the conversation.
 *   2. Assistant text and thinking stream out as ordinary `delta` / `reasoning`
 *      chunks, so the AI panel renders them exactly as it does for any provider.
 *   3. When Claude Code wants a tool, `canUseTool` fires in this process. We do
 *      not execute anything here — the tools edit a ProseMirror document that
 *      lives in the renderer. Instead we emit the call as a `tool-call` chunk
 *      followed by `done`, which is precisely what the AgentLoop expects at the
 *      end of a tool-calling turn. The permission callback then parks.
 *   4. The AgentLoop executes the tool against the document and opens the next
 *      turn, carrying the result. We match it to the parked call by id, resolve
 *      it, and the in-process MCP handler returns it to Claude Code — which
 *      never notices it was suspended.
 *
 * So GenOffice keeps its snapshots, degenerate-loop guards and UI, and Claude
 * Code keeps its loop, its context and its subscription login. Context is the
 * one thing that must not be shared: the renderer's history compaction is off
 * for this provider (ai-provider's `managesContext`), because the session
 * only ever receives the *last* user message and would take a "summarize"
 * turn for a real one. Claude Code auto-compacts its own transcript instead,
 * and each boundary is reported back as a `compaction` chunk.
 *
 * Session lifetime: one per document tab, ended with the tab's webContents
 * (`releaseClaudeCodeSessionWith`). Stop interrupts the open turn and keeps
 * the session (`interruptClaudeCodeSession`); a changed system prompt restarts
 * it resumed from the CLI's own transcript (`runClaudeCodeTurn`). Nothing here
 * ever reads a credential: the SDK spawns the user's own `claude` binary,
 * which finds its OAuth token in the OS keychain by itself.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import type { AgentImage, AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'
import type { AiCompaction, AiStreamChunk } from '@genoffice/ai-provider'
import { ccLocalTime, ccText, type ClaudeCodeMessageKey } from './i18n/claude-code-strings'

/**
 * Extra input field carrying the tool-use id from `canUseTool` through to the
 * MCP handler, which otherwise has no way to learn which call it is serving.
 * `canUseTool` returns it in `updatedInput`; the generated zod shape declares
 * it so schema validation cannot strip it. A FIFO fallback covers CLI versions
 * that drop the rewrite.
 */
const CALL_ID_FIELD = '__genoffice_call_id'

/** Name of the in-process MCP server exposing the document tools. */
const MCP_SERVER = 'genoffice'

/**
 * A parked tool call gives up after this long. Reaching it means the renderer
 * never came back — the run was abandoned mid-turn (window closed, loop hit its
 * turn cap) — and Claude Code would otherwise wait forever: permission prompts
 * have no deadline of their own.
 */
const TOOL_RESULT_TIMEOUT_MS = 10 * 60_000

/**
 * Large tool results. The CLI keeps any tool result above roughly 50 KB out
 * of the context: it writes the raw JSON to its own tool-results store and
 * hands the model a 2 KB preview plus a "saved to <file>" note (measured in
 * 2.1.259; the threshold is a per-tool, remotely flagged value, not a knob).
 * That file is one JSON line, which the model cannot page through with Read.
 * So the bridge does the same thing on its own terms, below the CLI's line:
 * a result over LARGE_RESULT_CHARS is written as plain text into the
 * session's private results directory, the model gets a note and a preview,
 * and a Read of that directory — the only Read this session allows — returns
 * the whole text in one call (CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS raised
 * from its 25K default). One extra round-trip inside the CLI; the renderer
 * sees nothing of it.
 */
const LARGE_RESULT_CHARS = 40_000
const RESULT_PREVIEW_CHARS = 1_500
const FILE_READ_MAX_TOKENS = 100_000

/**
 * The sessions' working directory: an empty scratch directory, never the
 * user's repo. Each session's persisted results live in their own
 * subdirectory of it, so a Read of them is a Read inside the cwd.
 */
const WORKDIR = join(tmpdir(), 'genoffice-claude-code')

/**
 * Tool calls the CLI issues within this window of each other travel to the
 * renderer as one turn (several `tool-call` chunks, one `done`), the way an
 * HTTP provider's parallel tool use does. The CLI only issues them together
 * for tools annotated read-only (measured: ~80 ms apart with the annotation,
 * strictly sequential without), so every tool carries the annotation — it
 * steers the CLI's scheduler only; the renderer executes the batch in order,
 * exactly as it does for every other provider.
 */
const TOOL_BATCH_WINDOW_MS = 400

/** Appended to every session's system prompt so the model knows what to do with a persisted result. */
const BRIDGE_PROMPT_SUFFIX =
  '\n\nWhen a tool result says its complete text was saved to a file, read that file with the Read tool before continuing; it fits in a single read.'

/**
 * Claude Code's own tools are off: this session's world is the open document.
 * Read stays available for the persisted-result files only (`canUseTool`
 * denies every other path). ToolSearch is off so the model never goes looking
 * for tools beyond the turn's own set.
 */
const DISALLOWED_BUILTINS = [
  'Bash',
  'BashOutput',
  'Edit',
  'Glob',
  'Grep',
  'KillShell',
  'NotebookEdit',
  'Task',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
]

type ToolOutcome = { output: string; isError?: boolean }

interface ParkedCall {
  resolve(outcome: ToolOutcome): void
  /** releases the serialization gate once the result is in */
  release(): void
  timer: NodeJS.Timeout
}

interface Session {
  /** the SDK query; an async generator we drain plus control methods */
  readonly drain: Promise<void>
  readonly abort: AbortController
  /** push a user message into the live session (images become image content blocks) */
  pushUser(text: string, images?: readonly AgentImage[] | undefined): void
  endInput(): void
  /** chunks go to whichever turn is currently open */
  send(chunk: AiStreamChunk): void
  requestId: string
  sink: (chunk: AiStreamChunk) => void
  readonly toolNames: Set<string>
  readonly parked: Map<string, ParkedCall>
  /** results awaited by MCP handlers, keyed by tool-use id */
  readonly outcomes: Map<string, Promise<ToolOutcome>>
  /** ids parked but not yet claimed by a handler, in call order (FIFO fallback) */
  readonly unclaimed: string[]
  /** serializes permission prompts so only one tool round-trip is open at a time */
  gate: Promise<void>
  ended: boolean
  stderr: string[]
  /**
   * Compaction reporting. The CLI announces a compaction twice — a
   * `compact_boundary` message (token counts) and a PostCompact hook (the
   * summary) — in no guaranteed order; whichever arrives second completes the
   * `compaction` chunk for the renderer.
   */
  pendingCompactSummary: string | null
  boundariesAwaitingSummary: number
  /** the SDK query handle (control requests such as interrupt); null until created */
  query: import('@anthropic-ai/claude-agent-sdk').Query | null
  /** the system prompt this session was created with; a different one restarts the session, resumed */
  readonly system: string
  /** the CLI's own session id from its init message — what `resume` needs */
  sessionId: string | null
  /** a turn is open (user text pushed or tool results delivered) until the CLI's result closes it */
  busy: boolean
  /** an interrupt was requested for the open turn: its result closes as a cancelled `done`, not an error */
  interrupting: boolean
  /**
   * Failure evidence for classifying a failed turn: the SDK's own class for
   * the last API error (carried on `api_retry` and on a failed assistant
   * message) and a rejected subscription rate limit, if one was announced.
   */
  lastApiError: { kind: string; status: number | null } | null
  rateLimit: { resetsAt?: number | undefined; type?: string | undefined } | null
  /** private directory for persisted large tool results; removed with the session */
  readonly resultsDir: string
  /** count of persisted results, for unique file names */
  largeResults: number
  /**
   * The tool calls currently travelling to the renderer as one turn. Open
   * while calls may still join (the batch window is running); closed once
   * `done` went out, after which it only waits for its results. `finish`
   * releases the session gate when the last result is in.
   */
  batch: ToolBatch | null
}

interface ToolBatch {
  closed: boolean
  /** parked calls whose result has not come back yet */
  pending: number
  timer: NodeJS.Timeout | null
  finish(): void
}

const sessions = new Map<string, Session>()

// ---- SDK loading -----------------------------------------------------------

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')
type Zod = typeof import('zod')

let sdkPromise: Promise<{ sdk: Sdk; z: Zod }> | null = null

function loadSdk(): Promise<{ sdk: Sdk; z: Zod }> {
  sdkPromise ??= (async () => {
    const [sdk, zodModule] = await Promise.all([
      import('@anthropic-ai/claude-agent-sdk'),
      import('zod'),
    ])
    return { sdk, z: zodModule }
  })().catch((err: unknown) => {
    sdkPromise = null
    throw new Error(
      `The Claude Agent SDK is not installed: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
  return sdkPromise
}

// ---- CLI discovery ---------------------------------------------------------

let cachedBinary: string | null | undefined

/**
 * Locates the user's own `claude`. A packaged app launched from the dock
 * inherits no login shell, so PATH is often just /usr/bin:/bin — the same
 * reason the proxy setting had to become explicit (see issue #45). Check the
 * usual install locations before giving up.
 */
export function findClaudeBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary
  const home = homedir()
  const candidates = [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, 'claude')),
  ]
  cachedBinary = candidates.find((candidate) => existsSync(candidate)) ?? null
  return cachedBinary
}

/** What the settings pane shows for this provider, from the CLI itself (no session needed). */
export interface ClaudeCodeStatus {
  /** the CLI is on this machine and runs */
  installed: boolean
  /** the CLI's version number, e.g. "2.1.259" */
  version: string | null
  /** signed in, per `claude auth status` */
  signedIn: boolean
  email: string | null
  /** e.g. "max", "pro", "team" */
  subscriptionType: string | null
  /** "claude.ai" (subscription) or an API-key/enterprise method */
  authMethod: string | null
}

/**
 * Probes the CLI: version, then `claude auth status`, which prints a JSON
 * document (loggedIn, email, subscriptionType, authMethod, …). Costs two
 * short spawns; no session, no model call.
 */
export function claudeCodeStatus(): ClaudeCodeStatus {
  // "2.1.259 (Claude Code)" → "2.1.259": the pane already names the product
  const version = claudeCodeVersion()?.split(' ')[0] ?? null
  const none: ClaudeCodeStatus = {
    installed: version !== null,
    version,
    signedIn: false,
    email: null,
    subscriptionType: null,
    authMethod: null,
  }
  const binary = findClaudeBinary()
  if (!binary || version === null) return none
  try {
    const probe = spawnSync(binary, ['auth', 'status'], { encoding: 'utf8', timeout: 10_000 })
    const parsed = JSON.parse(probe.stdout.trim()) as {
      loggedIn?: unknown
      email?: unknown
      subscriptionType?: unknown
      authMethod?: unknown
    }
    const str = (value: unknown) => (typeof value === 'string' && value ? value : null)
    return {
      ...none,
      signedIn: parsed.loggedIn === true,
      email: str(parsed.email),
      subscriptionType: str(parsed.subscriptionType),
      authMethod: str(parsed.authMethod),
    }
  } catch {
    return none
  }
}

/** Version string of the installed CLI, or null when it is missing or unrunnable. */
export function claudeCodeVersion(): string | null {
  const binary = findClaudeBinary()
  if (!binary) return null
  try {
    const probe = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    return probe.status === 0 ? probe.stdout.trim() : null
  } catch {
    return null
  }
}

// ---- JSON Schema -> zod ----------------------------------------------------

/**
 * The SDK's in-process MCP server describes tools with a zod raw shape, while
 * every GenOffice skill describes them with JSON Schema. This covers the subset
 * the skills actually use (flat objects of scalars, enums and arrays); anything
 * unrecognized degrades to an unconstrained value rather than failing the tool,
 * since the model's own description is what really steers the call.
 */
function zodTypeFor(z: Zod, schema: Record<string, unknown>): import('zod').ZodTypeAny {
  const describe = (type: import('zod').ZodTypeAny) =>
    typeof schema.description === 'string' ? type.describe(schema.description) : type

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.filter((v): v is string => typeof v === 'string')
    if (values.length === schema.enum.length) {
      return describe(z.enum(values as [string, ...string[]]))
    }
  }

  switch (schema.type) {
    case 'string':
      return describe(z.string())
    case 'integer':
      return describe(z.number().int())
    case 'number':
      return describe(z.number())
    case 'boolean':
      return describe(z.boolean())
    case 'array': {
      const items = schema.items
      const element =
        items && typeof items === 'object'
          ? zodTypeFor(z, items as Record<string, unknown>)
          : z.unknown()
      return describe(z.array(element))
    }
    case 'object': {
      const shape = zodShapeFor(z, schema)
      // loose(): tool inputs are model-authored and may carry a field the
      // schema forgot; dropping the call over it is worse than passing it on
      return describe(z.object(shape).loose())
    }
    default:
      return describe(z.unknown())
  }
}

function zodShapeFor(
  z: Zod,
  schema: Record<string, unknown>,
): Record<string, import('zod').ZodTypeAny> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === 'string')
      : [],
  )
  const shape: Record<string, import('zod').ZodTypeAny> = {}
  for (const [name, property] of Object.entries(properties)) {
    const type = zodTypeFor(z, property)
    shape[name] = required.has(name) ? type : type.optional()
  }
  return shape
}

// ---- pushable input stream -------------------------------------------------

interface Pushable<T> {
  iterable: AsyncIterable<T>
  push(value: T): void
  end(): void
}

function makePushable<T>(): Pushable<T> {
  const queue: T[] = []
  let waiting: ((result: IteratorResult<T>) => void) | null = null
  let closed = false
  return {
    push(value) {
      if (closed) return
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value, done: false })
      } else {
        queue.push(value)
      }
    },
    end() {
      closed = true
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value: undefined as never, done: true })
      }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            const next = queue.shift()
            if (next !== undefined) return Promise.resolve({ value: next, done: false })
            if (closed) return Promise.resolve({ value: undefined as never, done: true })
            return new Promise((resolve) => {
              waiting = resolve
            })
          },
        }
      },
    },
  }
}

// ---- turn plumbing ---------------------------------------------------------

export interface ClaudeCodeTurn {
  requestId: string
  /** the skill's system prompt; replaces Claude Code's own coding-agent prompt */
  system: string
  messages: AgentMessage[]
  tools: AgentToolDef[]
  /** 'default' defers to whatever the CLI would pick for this account */
  model: string
  /**
   * Context window (tokens) the CLI auto-compacts this session against; the
   * CLI clamps it to [100K, 1M] and fires a third below it (the summary
   * buffer). Absent leaves the CLI's own policy in force. Applied when the
   * session starts.
   */
  autoCompactWindow?: number | undefined
  /** identifies the conversation; one live CLI session per key */
  sessionKey: string
  send(chunk: AiStreamChunk): void
}

/** The last user message — text and attached images — as the AgentLoop composed it for this turn. */
function lastUserMessage(messages: AgentMessage[]): {
  text: string
  images: readonly AgentImage[] | undefined
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'user') return { text: message.text, images: message.images }
  }
  return { text: '', images: undefined }
}

/**
 * Delivers tool results the renderer just executed to the calls parked in
 * `canUseTool`. Returns false when this turn is not a continuation — an
 * unmatched id means the loop moved on (a correction, a compacted history) and
 * the caller must treat the turn as fresh input instead.
 */
function deliverToolResults(session: Session, messages: AgentMessage[]): boolean {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'tool' || last.results.length === 0) return false
  if (!last.results.every((result) => session.parked.has(result.id))) return false
  session.busy = true
  for (const result of last.results) {
    const parked = session.parked.get(result.id)!
    session.parked.delete(result.id)
    clearTimeout(parked.timer)
    parked.resolve({ output: result.output, isError: result.isError })
    parked.release()
  }
  return true
}

/**
 * What the MCP handler returns for a tool result: the text itself, or — for a
 * result the CLI would otherwise persist as unreadable JSON — a note pointing
 * at the plain-text copy in the session's results directory plus a preview.
 */
function deliverable(session: Session, toolName: string, result: ToolOutcome): string {
  if (result.isError || result.output.length <= LARGE_RESULT_CHARS) return result.output
  mkdirSync(session.resultsDir, { recursive: true })
  session.largeResults += 1
  const file = join(session.resultsDir, `${toolName}-${session.largeResults}.txt`)
  writeFileSync(file, result.output, 'utf8')
  const kb = Math.round(result.output.length / 1024)
  return (
    `[This result is ${kb} KB, too large to return inline. Its complete text is saved at ${file} — ` +
    'read that file with the Read tool before continuing; it fits in a single read.]\n\n' +
    `Preview:\n${result.output.slice(0, RESULT_PREVIEW_CHARS)}…`
  )
}

/** Opens a batch and arms the session gate, which its last result releases. */
function openBatch(session: Session): ToolBatch {
  let finish!: () => void
  session.gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const batch: ToolBatch = { closed: false, pending: 0, timer: null, finish }
  session.batch = batch
  return batch
}

/** Fails every parked call (the MCP handlers return the message to the CLI as an error result). */
function failParked(session: Session, message: string): void {
  const batch = session.batch
  if (batch?.timer) {
    clearTimeout(batch.timer)
    batch.timer = null
  }
  for (const [, parked] of session.parked) {
    clearTimeout(parked.timer)
    parked.resolve({ output: message, isError: true })
    parked.release()
  }
  session.parked.clear()
  if (batch && !batch.closed) {
    batch.closed = true
    if (batch.pending === 0) batch.finish()
  }
}

/**
 * Tears the session down: the CLI process is aborted and the conversation is
 * gone (its transcript stays on disk, so a later `resume` can still pick it
 * up). An open turn is closed towards the renderer as a cancelled `done`.
 * Resolves once the drain loop has ended, i.e. the child has been reaped.
 */
export function cancelClaudeCodeSession(sessionKey: string): Promise<void> {
  const session = sessions.get(sessionKey)
  if (!session) return Promise.resolve()
  sessions.delete(sessionKey)
  failParked(session, 'The user cancelled this run.')
  if (session.busy) {
    session.busy = false
    session.send({ requestId: session.requestId, type: 'done', stopReason: 'cancelled' })
  }
  session.ended = true
  session.endInput()
  session.abort.abort()
  return session.drain
}

/**
 * Stops the open turn but keeps the session and everything it remembers: the
 * CLI answers an interrupt with an `error_during_execution` result, which the
 * drain loop turns into a cancelled `done` for the renderer. A parked tool
 * call is failed first so the CLI's own tool loop unwinds. Falls back to a
 * full cancel when the CLI does not accept the control request.
 */
export async function interruptClaudeCodeSession(sessionKey: string): Promise<void> {
  const session = sessions.get(sessionKey)
  if (!session || session.ended) return
  if (!session.busy) return
  failParked(session, 'The user cancelled this run.')
  session.interrupting = true
  try {
    if (!session.query) throw new Error('session has no query handle')
    await session.query.interrupt()
  } catch {
    session.interrupting = false
    await cancelClaudeCodeSession(sessionKey)
  }
}

/** Ends every session (app shutdown, test teardown); resolves once all children are reaped. */
export function cancelAllClaudeCodeSessions(): Promise<void> {
  return Promise.all([...sessions.keys()].map((key) => cancelClaudeCodeSession(key))).then(
    () => undefined,
  )
}

/** Whether a live session exists for the key (settings/status surfaces, tests). */
export function hasClaudeCodeSession(sessionKey: string): boolean {
  const session = sessions.get(sessionKey)
  return session !== undefined && !session.ended
}

/** The subset of Electron's WebContents the teardown hook needs. */
export interface ClaudeCodeSessionOwner {
  once(event: 'destroyed', listener: () => void): unknown
}

const hookedOwners = new WeakSet<ClaudeCodeSessionOwner>()

/**
 * Ends the session with the webContents that owns it (a closed tab), so the
 * `claude` child does not live on until the app exits. One hook per owner;
 * safe to call on every turn.
 */
export function releaseClaudeCodeSessionWith(
  owner: ClaudeCodeSessionOwner,
  sessionKey: string,
): void {
  if (hookedOwners.has(owner)) return
  hookedOwners.add(owner)
  owner.once('destroyed', () => {
    void cancelClaudeCodeSession(sessionKey)
  })
}

/**
 * Serves one turn. Resolves as soon as the turn has been handed to the session
 * — the chunks themselves arrive asynchronously from the drain loop, exactly as
 * they do for an HTTP provider.
 *
 * The system prompt is fixed for the life of a CLI session, but the AgentLoop
 * composes it per turn (skill capabilities, the UI-language directive). A
 * fresh user turn arriving with a different prompt therefore restarts the
 * session with the new prompt, resumed from the CLI's own transcript so
 * nothing is forgotten. A tool-result continuation always goes to its parked
 * call; a prompt change during a run takes effect at the next user turn.
 */
export async function runClaudeCodeTurn(turn: ClaudeCodeTurn): Promise<void> {
  const existing = sessions.get(turn.sessionKey)
  let resume: string | undefined
  if (existing && !existing.ended) {
    existing.requestId = turn.requestId
    existing.sink = turn.send
    if (deliverToolResults(existing, turn.messages)) return
    const { text, images } = lastUserMessage(turn.messages)
    if (text && (turn.system === existing.system || !existing.sessionId)) {
      existing.pushUser(text, images)
      return
    }
    resume = existing.sessionId ?? undefined
    // a fresh turn boundary: nothing is parked and no turn is open, so this
    // closes nothing towards the renderer
    void cancelClaudeCodeSession(turn.sessionKey)
  }
  await startSession(turn, resume)
}

async function startSession(turn: ClaudeCodeTurn, resume?: string): Promise<void> {
  const { sdk, z } = await loadSdk()
  const binary = findClaudeBinary()
  if (!binary) {
    throw new Error(ccText('ccNotInstalled'))
  }

  const input = makePushable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>()
  const abort = new AbortController()
  const session: Session = {
    drain: Promise.resolve(),
    abort,
    pushUser(text, images) {
      session.busy = true
      // Messages API shape: image blocks first, then the text — a vision
      // provider; the adapter declares it, so the renderer attaches images
      const content = images?.length
        ? [
            ...images.map((image) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: image.mime, data: image.base64 },
            })),
            { type: 'text' as const, text },
          ]
        : text
      input.push({
        type: 'user',
        message: {
          role: 'user',
          content:
            content as import('@anthropic-ai/claude-agent-sdk').SDKUserMessage['message']['content'],
        },
        parent_tool_use_id: null,
      })
    },
    endInput: () => input.end(),
    send(chunk) {
      if (!this.ended) this.sink(chunk)
    },
    requestId: turn.requestId,
    sink: turn.send,
    toolNames: new Set(turn.tools.map((tool) => tool.name)),
    parked: new Map(),
    outcomes: new Map(),
    unclaimed: [],
    gate: Promise.resolve(),
    ended: false,
    stderr: [],
    pendingCompactSummary: null,
    boundariesAwaitingSummary: 0,
    query: null,
    system: turn.system,
    sessionId: null,
    busy: false,
    interrupting: false,
    lastApiError: null,
    rateLimit: null,
    resultsDir: join(WORKDIR, 'results', randomUUID()),
    largeResults: 0,
    batch: null,
  }

  const mcpTools = turn.tools.map((tool) =>
    sdk.tool(
      tool.name,
      tool.description,
      {
        ...zodShapeFor(z, tool.inputSchema),
        [CALL_ID_FIELD]: z.string().optional(),
      },
      async (args: Record<string, unknown>) => {
        const id =
          typeof args[CALL_ID_FIELD] === 'string'
            ? (args[CALL_ID_FIELD] as string)
            : session.unclaimed.shift()
        const outcome = id ? session.outcomes.get(id) : undefined
        if (!id || !outcome) {
          return {
            content: [
              { type: 'text' as const, text: 'Bridge error: this call was never registered.' },
            ],
            isError: true,
          }
        }
        session.outcomes.delete(id)
        const claimed = session.unclaimed.indexOf(id)
        if (claimed >= 0) session.unclaimed.splice(claimed, 1)
        const result = await outcome
        return {
          content: [{ type: 'text' as const, text: deliverable(session, tool.name, result) }],
          ...(result.isError ? { isError: true } : {}),
        }
      },
      // scheduler hint only (see TOOL_BATCH_WINDOW_MS): the renderer runs the
      // batch in order, so nothing here executes concurrently
      { annotations: { readOnlyHint: true } },
    ),
  )

  const canUseTool: import('@anthropic-ai/claude-agent-sdk').CanUseTool = async (
    toolName,
    input_,
    { toolUseID },
  ) => {
    // The one built-in this session may use: reading back a large result the
    // bridge persisted for it — nothing else on disk.
    if (toolName === 'Read') {
      const path = typeof input_.file_path === 'string' ? input_.file_path : ''
      return path.startsWith(session.resultsDir + sep)
        ? { behavior: 'allow', updatedInput: input_ }
        : {
            behavior: 'deny',
            message: 'Only the files this session saved its own tool results to may be read.',
          }
    }
    const bare = toolName.startsWith(`mcp__${MCP_SERVER}__`)
      ? toolName.slice(`mcp__${MCP_SERVER}__`.length)
      : toolName
    if (!session.toolNames.has(bare)) {
      return {
        behavior: 'deny',
        message: `${toolName} is not available here. This session edits the open document through its own tools only.`,
      }
    }

    // One batch of tool calls per renderer turn: calls arriving within the
    // batch window join the open batch; anything later waits for that batch's
    // results, because the renderer's loop has settled the turn by then and
    // a call streamed into it would never come back.
    let batch = session.batch
    if (!batch || batch.closed) {
      await session.gate
      if (session.ended) {
        return { behavior: 'deny', message: 'The run was cancelled.' }
      }
      batch = session.batch && !session.batch.closed ? session.batch : openBatch(session)
    }
    const joined = batch
    joined.pending += 1
    const release = () => {
      joined.pending -= 1
      if (joined.closed && joined.pending === 0) joined.finish()
    }

    const outcome = new Promise<ToolOutcome>((resolve) => {
      const timer = setTimeout(() => {
        session.parked.delete(toolUseID)
        resolve({ output: 'The editor did not return a result for this call.', isError: true })
        release()
      }, TOOL_RESULT_TIMEOUT_MS)
      session.parked.set(toolUseID, { resolve, release, timer })
    })
    session.outcomes.set(toolUseID, outcome)
    session.unclaimed.push(toolUseID)

    const call: AgentToolCall = { id: toolUseID, name: bare, input: input_ }
    session.send({ requestId: session.requestId, type: 'tool-call', toolCall: call })
    // the turn closes once no sibling call has arrived for a window
    if (joined.timer) clearTimeout(joined.timer)
    joined.timer = setTimeout(() => {
      joined.timer = null
      if (joined.closed) return
      joined.closed = true
      session.send({ requestId: session.requestId, type: 'done', stopReason: 'tool_use' })
      if (joined.pending === 0) joined.finish()
    }, TOOL_BATCH_WINDOW_MS)

    return { behavior: 'allow', updatedInput: { ...input_, [CALL_ID_FIELD]: toolUseID } }
  }

  mkdirSync(WORKDIR, { recursive: true })

  const emitCompaction = (info: AiCompaction) =>
    session.send({ requestId: session.requestId, type: 'compaction', compaction: info })
  const onPostCompact = (summary: string, trigger: AiCompaction['trigger']) => {
    if (session.boundariesAwaitingSummary > 0) {
      session.boundariesAwaitingSummary--
      emitCompaction({ trigger, summary })
    } else {
      session.pendingCompactSummary = summary
    }
  }

  const query = sdk.query({
    prompt: input.iterable,
    options: {
      pathToClaudeCodeExecutable: binary,
      // The document skill's prompt replaces Claude Code's coding-agent
      // preset entirely: this session edits a docx, it does not touch a repo.
      systemPrompt: { type: 'custom', prompt: turn.system + BRIDGE_PROMPT_SUFFIX },
      // A restart for a changed prompt picks the conversation up from the
      // CLI's own transcript (a custom prompt is rendered afresh per launch
      // unless snapshotted, which this one is not).
      ...(resume ? { resume } : {}),
      // The session is the conversation's only memory (the renderer's copy is
      // display-only), so the CLI must keep compacting it itself. Stated
      // explicitly rather than relied on as the default. The window is left to
      // the CLI's policy unless the turn pins one; the pin goes through the
      // CLI's environment variable, which it clamps to [100K, 1M] tokens (the
      // `autoCompactWindow` settings key is not consulted for an SDK session —
      // verified against 2.1.259).
      settings: {
        autoCompactEnabled: true,
        // the user's claude.ai connectors (mail, drive, …) are theirs, not the
        // document's: never fetched into this session
        disableClaudeAiConnectors: true,
      },
      env: {
        ...process.env,
        // one Read returns a persisted result whole (default cap: 25K tokens)
        CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: String(FILE_READ_MAX_TOKENS),
        ...(turn.autoCompactWindow !== undefined
          ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(turn.autoCompactWindow) }
          : {}),
      },
      hooks: {
        PostCompact: [
          {
            hooks: [
              async (hookInput) => {
                if (hookInput.hook_event_name === 'PostCompact') {
                  onPostCompact(hookInput.compact_summary, hookInput.trigger)
                }
                return {}
              },
            ],
          },
        ],
      },
      ...(turn.model && turn.model !== 'default' ? { model: turn.model } : {}),
      mcpServers: {
        [MCP_SERVER]: sdk.createSdkMcpServer({ name: MCP_SERVER, tools: mcpTools }),
      },
      canUseTool,
      // SDK isolation: the user's own settings, CLAUDE.md and skills are for
      // their code, not for a document the app opened on their behalf.
      settingSources: [],
      disallowedTools: DISALLOWED_BUILTINS,
      cwd: WORKDIR,
      includePartialMessages: true,
      abortController: abort,
      stderr: (data) => {
        session.stderr.push(data)
        if (session.stderr.length > 50) session.stderr.shift()
      },
    },
  })

  session.query = query
  sessions.set(turn.sessionKey, session)
  const first = lastUserMessage(turn.messages)
  session.pushUser(first.text, first.images)

  const drain = (async () => {
    try {
      for await (const message of query) {
        if (session.ended) break
        if (message.type === 'stream_event') {
          const event = message.event
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              session.send({
                requestId: session.requestId,
                type: 'delta',
                text: event.delta.text,
              })
            } else if (event.delta.type === 'thinking_delta') {
              session.send({
                requestId: session.requestId,
                type: 'reasoning',
                text: event.delta.thinking,
              })
            }
          } else {
            // any other frame is still proof of life for the renderer's
            // silence watchdog, which fires at 240s of nothing
            session.send({ requestId: session.requestId, type: 'ping' })
          }
        } else if (message.type === 'system' && message.subtype === 'api_retry') {
          // the CLI retries API failures for minutes with backoff: proof of
          // life for the renderer's watchdog, and the SDK's error class is the
          // best evidence for classifying the failure if it gives up
          session.lastApiError = { kind: message.error, status: message.error_status }
          session.send({ requestId: session.requestId, type: 'ping' })
        } else if (message.type === 'rate_limit_event') {
          const info = message.rate_limit_info
          if (info.status === 'rejected') {
            session.rateLimit = { resetsAt: info.resetsAt, type: info.rateLimitType }
          }
          session.send({ requestId: session.requestId, type: 'ping' })
        } else if (message.type === 'assistant' && message.error) {
          session.lastApiError = { kind: message.error, status: null }
        } else if (message.type === 'system' && message.subtype === 'init') {
          session.sessionId = message.session_id
        } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
          const meta = message.compact_metadata
          const summary = session.pendingCompactSummary
          session.pendingCompactSummary = null
          if (summary === null) session.boundariesAwaitingSummary++
          emitCompaction({
            trigger: meta.trigger,
            preTokens: meta.pre_tokens,
            postTokens: meta.post_tokens,
            ...(summary !== null ? { summary } : {}),
          })
        } else if (message.type === 'result') {
          session.busy = false
          if (session.interrupting) {
            // the CLI reports an interrupted turn as error_during_execution;
            // to the renderer it is the cancel it asked for
            session.interrupting = false
            session.send({ requestId: session.requestId, type: 'done', stopReason: 'cancelled' })
          } else if (message.subtype === 'success') {
            session.send({ requestId: session.requestId, type: 'done', stopReason: 'end_turn' })
          } else {
            const failure = classifyClaudeCodeFailure({
              subtype: message.subtype,
              errors: message.errors ?? [],
              stderr: session.stderr,
              lastApiError: session.lastApiError,
              rateLimit: session.rateLimit,
              terminalReason: message.terminal_reason,
            })
            session.send({
              requestId: session.requestId,
              type: 'error',
              error: renderFailure(failure),
              ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
            })
          }
          // evidence is per turn
          session.lastApiError = null
          session.rateLimit = null
        }
      }
    } catch (err) {
      if (!session.ended) {
        session.send({
          requestId: session.requestId,
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      session.ended = true
      if (sessions.get(turn.sessionKey) === session) sessions.delete(turn.sessionKey)
      rmSync(session.resultsDir, { recursive: true, force: true })
      for (const [, parked] of session.parked) {
        clearTimeout(parked.timer)
        parked.resolve({ output: 'The session ended before this call completed.', isError: true })
        parked.release()
      }
      session.parked.clear()
    }
  })()

  Object.assign(session, { drain })
  void drain
}

/** What the drain loop knows about a failed turn. */
export interface ClaudeCodeFailureEvidence {
  /** the result's subtype (error_during_execution, error_max_turns, …) */
  subtype: string
  /** the result's own error strings */
  errors: readonly string[]
  /** the CLI's recent stderr */
  stderr: readonly string[]
  /** the SDK's class for the last API error seen during the turn, if any */
  lastApiError: { kind: string; status: number | null } | null
  /** a rejected subscription rate limit announced during the turn, if any */
  rateLimit: { resetsAt?: number | undefined; type?: string | undefined } | null
  /** the result's terminal_reason, if the CLI reported one */
  terminalReason: string | undefined
}

export interface ClaudeCodeFailure {
  /** message key in the bridge dictionary (localized in the main process, `renderFailure`) */
  key: ClaudeCodeMessageKey
  params?: Record<string, string | number>
  /** the CLI's stderr tail, appended when it adds anything */
  detail?: string
  /** renderer-localized code; absent when the localized message above says it better */
  errorCode?: 'timeout' | 'network' | 'overloaded'
}

/** The failure as the AI panel shows it: localized message plus the stderr tail. */
export function renderFailure(failure: ClaudeCodeFailure): string {
  const text = ccText(failure.key, failure.params)
  return failure.detail ? `${text}\n${failure.detail}` : text
}

const NETWORK_SIGNATURES =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed|network error|socket hang up/i
const TIMEOUT_SIGNATURES = /ETIMEDOUT|timed? ?out/i

/**
 * Maps a failed turn onto a message key, and where the renderer's own
 * localized text says it better, onto its error code (`timeout` | `network`
 * | `overloaded`). Evidence in order of reliability: the SDK's own error
 * class, a rejected rate limit, the CLI's terminal reason, then stderr/error
 * text signatures.
 *
 * A subscription limit gets its own localized message (with the reset time)
 * rather than a code; API overload maps to `overloaded`, the renderer's "try
 * again later". `credits` is deliberately unused — its text is about Genspark
 * credits, which would mislead here.
 */
export function classifyClaudeCodeFailure(evidence: ClaudeCodeFailureEvidence): ClaudeCodeFailure {
  const { subtype, lastApiError, rateLimit, terminalReason } = evidence
  const text = [...evidence.errors, evidence.stderr.join('')].join('\n')
  const tail = evidence.stderr.join('').trim().slice(-500)
  const detail = tail ? { detail: tail } : {}

  if (rateLimit || lastApiError?.kind === 'rate_limit' || terminalReason === 'blocking_limit') {
    const resetsAt = rateLimit?.resetsAt
    return resetsAt
      ? { key: 'ccUsageLimitResets', params: { time: ccLocalTime(resetsAt) } }
      : { key: 'ccUsageLimit' }
  }
  if (lastApiError?.kind === 'overloaded' || lastApiError?.kind === 'server_error') {
    return {
      key: 'ccOverloaded',
      params: { status: lastApiError.status ?? '?' },
      errorCode: 'overloaded',
    }
  }
  if (
    lastApiError?.kind === 'authentication_failed' ||
    lastApiError?.kind === 'oauth_org_not_allowed'
  ) {
    return { key: 'ccNotSignedIn' }
  }
  if (lastApiError?.kind === 'billing_error' || lastApiError?.kind === 'account_on_hold') {
    return { key: 'ccBilling' }
  }
  if (terminalReason === 'prompt_too_long') {
    return { key: 'ccPromptTooLong' }
  }
  if (NETWORK_SIGNATURES.test(text)) {
    return { key: 'ccNetwork', errorCode: 'network', ...detail }
  }
  if (TIMEOUT_SIGNATURES.test(text)) {
    return { key: 'ccTimeout', errorCode: 'timeout', ...detail }
  }
  return subtype === 'error_max_turns'
    ? { key: 'ccTurnLimit', ...detail }
    : { key: 'ccEndedWith', params: { subtype }, ...detail }
}
