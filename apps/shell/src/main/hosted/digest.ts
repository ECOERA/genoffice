/**
 * Digest — a hosted MCP server (see mcp-host.ts) plus a scheduled job: new
 * or changed files in the knowledge base folders are summarised with the
 * configured AI provider and collected into `~/.genoffice/kb/digest-<date>.md`,
 * which is itself indexed so the summaries are searchable. Runs on a timer
 * in the app (default daily) and on demand through `digest_run`. The
 * summariser is injected: the shell routes it to the active provider (or a
 * Gemini key when the provider cannot be called from the main process).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { textResult, type HostedServer, type HostedTool } from '../mcp-host'
import { displayPath, type FileRow, type KnowledgeBase } from './kb'

export interface DigestOptions {
  kb: KnowledgeBase
  notesDir: string
  /** where lastRun is remembered */
  statePath: string
  /** returns a summary for a document, or throws with a reason (no provider, network…) */
  summarize: (title: string, text: string) => Promise<string>
  log?: (message: string) => void
  /** characters of each document handed to the summariser */
  maxCharsPerFile?: number
}

export interface DigestResult {
  path: string | null
  summarized: number
  skipped: string[]
  since: number
  markdown: string
}

interface State {
  lastRun: number
  lastPath?: string
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

export class Digest {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<DigestResult> | null = null
  constructor(private readonly opts: DigestOptions) {}

  state(): State {
    try {
      if (existsSync(this.opts.statePath))
        return JSON.parse(readFileSync(this.opts.statePath, 'utf8')) as State
    } catch {
      /* corrupt state: start over */
    }
    return { lastRun: 0 }
  }

  private save(state: State): void {
    mkdirSync(dirname(this.opts.statePath), { recursive: true })
    writeFileSync(this.opts.statePath, JSON.stringify(state, null, 2))
  }

  /** summarise what changed since `sinceMs` (default: the last run) into today's digest file */
  run(sinceMs?: number, maxFiles = 20): Promise<DigestResult> {
    if (this.running) return this.running
    this.running = this.runOnce(sinceMs, maxFiles).finally(() => {
      this.running = null
    })
    return this.running
  }

  private async runOnce(sinceMs: number | undefined, maxFiles: number): Promise<DigestResult> {
    const state = this.state()
    const since = sinceMs ?? state.lastRun
    const started = Date.now()
    const files = this.opts.kb.recentFiles(since, clamp(maxFiles, 1, 100))
    const sections: string[] = []
    const skipped: string[] = []
    for (const f of files) {
      const doc = await this.opts.kb.read(f.path).catch(() => null)
      if (!doc?.text) {
        skipped.push(`${displayPath(f.path)} (no text)`)
        continue
      }
      try {
        const summary = await this.opts.summarize(
          doc.title,
          doc.text.slice(0, this.opts.maxCharsPerFile ?? 12_000),
        )
        sections.push(
          `## ${doc.title}\n\n${displayPath(f.path)} · modified ${new Date(f.mtime).toISOString().slice(0, 10)}\n\n${summary.trim()}\n`,
        )
      } catch (err) {
        skipped.push(`${displayPath(f.path)} (${err instanceof Error ? err.message : String(err)})`)
        // a provider that fails once will fail for the rest: stop early
        if (/provider|not configured|API key|not signed in/i.test(String(err))) break
      }
    }
    const day = new Date(started).toISOString().slice(0, 10)
    let path: string | null = null
    let markdown = ''
    if (sections.length) {
      markdown = `# Digest ${day}\n\n${sections.length} document${sections.length === 1 ? '' : 's'} since ${since ? new Date(since).toISOString().slice(0, 16).replace('T', ' ') : 'the beginning'}.\n\n${sections.join('\n')}`
      mkdirSync(this.opts.notesDir, { recursive: true })
      path = join(this.opts.notesDir, `digest-${day}.md`)
      if (existsSync(path)) {
        const time = new Date(started).toISOString().slice(11, 16)
        writeFileSync(
          path,
          `${readFileSync(path, 'utf8').trimEnd()}\n\n---\n\n## Later run (${time})\n\n${sections.join('\n')}`,
        )
      } else writeFileSync(path, markdown)
      await this.opts.kb.indexFile(path).catch(() => {})
    }
    this.save({ lastRun: started, lastPath: path ?? state.lastPath })
    this.opts.log?.(
      `digest: ${sections.length} summarised, ${skipped.length} skipped${path ? ` → ${path}` : ''}`,
    )
    return { path, summarized: sections.length, skipped, since, markdown }
  }

  /**
   * run when the last run is older than `everyMs`, then keep checking; first
   * check after `delayMs`; `enabled` gates each tick (the shell passes
   * "a digest entry is configured", so nobody pays for summaries unasked)
   */
  schedule(everyMs: number, delayMs = 5 * 60_000, enabled: () => boolean = () => true): void {
    this.stop()
    const tick = () => {
      if (enabled() && Date.now() - this.state().lastRun >= everyMs) {
        void this.run().catch((err) => this.opts.log?.(`digest: ${String(err)}`))
      }
    }
    const first = setTimeout(() => {
      tick()
      this.timer = setInterval(tick, Math.min(everyMs, 60 * 60_000))
    }, delayMs)
    first.unref?.()
    this.timer = first as unknown as ReturnType<typeof setInterval>
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

export function createDigestServer(digest: Digest): HostedServer {
  const tools: HostedTool[] = [
    {
      name: 'digest_run',
      description:
        "Summarise the documents added or changed in the user's knowledge base since the last digest (or since a date) into today's digest note (~/.genoffice/kb/digest-<date>.md), which is indexed and searchable. Use when the user asks what is new, wants a weekly digest, or wants the inbox caught up.",
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'ISO date; default: the previous run' },
          max_files: { type: 'integer', description: '1–100, default 20' },
        },
      },
      run: async (args) => {
        const since =
          typeof args.since === 'string' && args.since ? Date.parse(args.since) : undefined
        if (since !== undefined && Number.isNaN(since))
          return textResult('since must be an ISO date', true)
        const r = await digest.run(since, clamp(Number(args.max_files) || 20, 1, 100))
        if (!r.summarized) {
          return `Nothing new to digest since ${r.since ? new Date(r.since).toISOString().slice(0, 16).replace('T', ' ') : 'the beginning'}.${r.skipped.length ? `\nSkipped: ${r.skipped.join('; ')}` : ''}`
        }
        return `${r.markdown}\n\nSaved as ${displayPath(r.path!)}.${r.skipped.length ? `\nSkipped: ${r.skipped.join('; ')}` : ''}`
      },
    },
    {
      name: 'digest_status',
      description: 'When the digest last ran and where the latest digest note is.',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const s = digest.state()
        return s.lastRun
          ? `Last digest: ${new Date(s.lastRun).toISOString().slice(0, 16).replace('T', ' ')}${s.lastPath ? ` → ${displayPath(s.lastPath)}` : ' (nothing new then)'}`
          : 'The digest has not run yet.'
      },
    },
  ]
  return { name: 'digest', version: '1.0.0', tools }
}

export type { FileRow }
