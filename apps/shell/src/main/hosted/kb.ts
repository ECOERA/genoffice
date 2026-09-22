/**
 * Knowledge base — "ask my documents". A hosted MCP server (see mcp-host.ts)
 * that indexes the user's document folders into SQLite FTS5 and lets the
 * assistant search, read and cite them, plus a notes folder it can write to.
 *
 * - Text comes from @genoffice/file-parse (doc/docx/ppt/pptx/xlsx/pdf and
 *   plain-text formats), split into ~1400-character chunks so a hit points at
 *   the right passage, not just the file.
 * - Incremental: a file is re-read only when its mtime or size changed;
 *   vanished files leave the index. Folders are watched (recursive fs.watch)
 *   and rescanned shortly after a change.
 * - Roots: the options' defaults plus `KB_ROOTS` from the mcp.json entry env
 *   (`;`- or `:`-separated, `~` allowed).
 *
 * Pure Node (no Electron import) so vitest can drive it directly.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { parseFileToText, pdfToText } from '@genoffice/file-parse'
import { textResult, type HostedContext, type HostedServer, type HostedTool } from '../mcp-host'

export interface KnowledgeBaseOptions {
  dbPath: string
  roots: string[]
  notesDir: string
  /** downloads a PDF for pdf_read_url; the shell passes its SSRF-guarded fetch */
  fetchPdf?: (url: string) => Promise<Buffer | null>
  log?: (message: string) => void
  /** watch the roots and rescan on changes (default true; tests turn it off) */
  watch?: boolean
}

export interface ScanSummary {
  added: number
  updated: number
  removed: number
  unreadable: number
  files: number
  chunks: number
  ms: number
}

const SUPPORTED = new Set([
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xlsx',
  'xlsm',
  'pdf',
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'html',
  'htm',
  'xml',
  'yaml',
  'yml',
  'rtf',
])
const SKIP_DIRS = new Set(['node_modules', '.git', '.Trash', 'Library'])
const MAX_BYTES = 80 * 1024 * 1024
const CHUNK_CHARS = 1400
const MAX_FILES = 20_000

export function expandHome(p: string): string {
  return resolve(p.startsWith('~') ? join(homedir(), p.slice(1)) : p)
}

export function displayPath(p: string): string {
  const home = homedir()
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

/** paragraphs packed into chunks of about CHUNK_CHARS, long paragraphs split at whitespace */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const paras = text
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  const out: string[] = []
  let cur = ''
  const flush = () => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const p of paras) {
    if (p.length > size) {
      flush()
      let rest = p
      while (rest.length > size) {
        const cut = rest.lastIndexOf(' ', size)
        const at = cut > size / 2 ? cut : size
        out.push(rest.slice(0, at).trim())
        rest = rest.slice(at).trim()
      }
      if (rest) out.push(rest)
      continue
    }
    if (cur.length + p.length + 2 > size) flush()
    cur = cur ? `${cur}\n\n${p}` : p
  }
  flush()
  return out
}

function titleOf(text: string, path: string): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length >= 3 && l.length <= 140)
  return line ?? basename(path)
}

/** FTS5 MATCH expression: quoted phrases kept, bare words prefix-matched, AND or OR between them */
export function ftsQuery(q: string, mode: 'and' | 'or'): string {
  const phrases = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.trim()).filter(Boolean)
  const words = q
    .replace(/"[^"]*"/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((w) => w.length > 1)
  const parts = [
    ...phrases.map((p) => `"${p.replace(/"/g, '""')}"`),
    ...words.map((w) => (w.length >= 4 ? `"${w}"*` : `"${w}"`)),
  ]
  return parts.join(mode === 'and' ? ' ' : ' OR ')
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export interface FileRow {
  path: string
  mtime: number
  size: number
  title: string
  kind: string
  chars: number
  status: string
}

export class KnowledgeBase {
  private readonly db: DatabaseSync
  private roots: string[]
  private readonly watchers: FSWatcher[] = []
  private scanning: Promise<ScanSummary> | null = null
  private rescanWanted = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastScan: ScanSummary | null = null
  private closed = false

  constructor(private readonly opts: KnowledgeBaseOptions) {
    mkdirSync(dirname(opts.dbPath), { recursive: true })
    mkdirSync(opts.notesDir, { recursive: true })
    this.roots = []
    this.db = new DatabaseSync(opts.dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER, title TEXT, kind TEXT,
        chars INTEGER, status TEXT, indexed_at INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        path UNINDEXED, idx UNINDEXED, title, body, tokenize="unicode61 remove_diacritics 2"
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `)
    this.setRoots([...opts.roots, opts.notesDir])
  }

  get rootDirs(): string[] {
    return [...this.roots]
  }

  /** adds roots (deduplicated, `~` expanded); returns true when the set changed */
  setRoots(roots: string[]): boolean {
    const next = new Set(this.roots)
    for (const r of roots) if (r.trim()) next.add(expandHome(r.trim()))
    if (next.size === this.roots.length) return false
    this.roots = [...next]
    if (this.opts.watch !== false && this.watchers.length) this.watchRoots()
    return true
  }

  /** first scan plus the folder watchers; safe to call once at app start */
  async start(): Promise<ScanSummary> {
    if (this.opts.watch !== false) this.watchRoots()
    return this.scan()
  }

  private watchRoots(): void {
    for (const w of this.watchers.splice(0)) w.close()
    for (const root of this.roots) {
      if (!existsSync(root)) continue
      try {
        const w = watch(root, { recursive: true }, () => this.scheduleScan(1500))
        w.on('error', () => {})
        this.watchers.push(w)
      } catch (err) {
        this.opts.log?.(`kb: cannot watch ${root}: ${String(err)}`)
      }
    }
  }

  private scheduleScan(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.scan().catch((err) => this.opts.log?.(`kb: scan failed: ${String(err)}`))
    }, delayMs)
  }

  /** incremental scan of every root; a scan requested during a scan runs once more afterwards */
  scan(): Promise<ScanSummary> {
    if (this.scanning) {
      this.rescanWanted = true
      return this.scanning
    }
    this.scanning = this.scanOnce().finally(() => {
      this.scanning = null
      if (this.rescanWanted && !this.closed) {
        this.rescanWanted = false
        this.scheduleScan(200)
      }
    })
    return this.scanning
  }

  private async scanOnce(): Promise<ScanSummary> {
    const started = Date.now()
    const summary: ScanSummary = {
      added: 0,
      updated: 0,
      removed: 0,
      unreadable: 0,
      files: 0,
      chunks: 0,
      ms: 0,
    }
    const seen = new Set<string>()
    const known = new Map<string, FileRow>()
    for (const row of this.db.prepare('SELECT * FROM files').all() as unknown as FileRow[])
      known.set(row.path, row)
    for (const root of this.roots) {
      if (!existsSync(root)) continue
      for (const path of this.walk(root)) {
        if (seen.size >= MAX_FILES) break
        seen.add(path)
        let st
        try {
          st = statSync(path)
        } catch {
          continue
        }
        if (st.size > MAX_BYTES) continue
        const prev = known.get(path)
        if (prev && prev.mtime === Math.round(st.mtimeMs) && prev.size === st.size) continue
        const ok = await this.indexFile(path, Math.round(st.mtimeMs), st.size)
        if (!ok) summary.unreadable++
        else if (prev) summary.updated++
        else summary.added++
        // let the event loop breathe between files (PDF parsing is CPU-heavy)
        await new Promise((r) => setImmediate(r))
      }
    }
    for (const path of known.keys()) {
      if (seen.has(path)) continue
      this.forget(path)
      summary.removed++
    }
    summary.files = this.count('files')
    summary.chunks = this.count('chunks')
    summary.ms = Date.now() - started
    this.db
      .prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)')
      .run('lastScan', new Date().toISOString())
    this.lastScan = summary
    if (summary.added || summary.updated || summary.removed) {
      this.opts.log?.(
        `kb: +${summary.added} ~${summary.updated} -${summary.removed} (${summary.files} files, ${summary.chunks} chunks, ${summary.ms} ms)`,
      )
    }
    return summary
  }

  private *walk(dir: string): Generator<string> {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('~$') || SKIP_DIRS.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) yield* this.walk(full)
      else if (e.isFile() && SUPPORTED.has(extname(e.name).slice(1).toLowerCase())) yield full
    }
  }

  private count(table: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  }

  /** (re)reads one file into the index; false when it could not be parsed (remembered until it changes) */
  async indexFile(path: string, mtime?: number, size?: number): Promise<boolean> {
    if (mtime === undefined || size === undefined) {
      const st = statSync(path)
      mtime = Math.round(st.mtimeMs)
      size = st.size
    }
    const parsed = await parseFileToText(path)
    const text = parsed.ok && typeof parsed.text === 'string' ? parsed.text : ''
    const kind = extname(path).slice(1).toLowerCase()
    const title = text ? titleOf(text, path) : basename(path)
    const chunks = text ? chunkText(text) : []
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM chunks WHERE path = ?').run(path)
      const ins = this.db.prepare('INSERT INTO chunks (path, idx, title, body) VALUES (?, ?, ?, ?)')
      chunks.forEach((body, idx) => ins.run(path, idx, title, body))
      this.db
        .prepare(
          'INSERT OR REPLACE INTO files (path, mtime, size, title, kind, chars, status, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          path,
          mtime,
          size,
          title,
          kind,
          text.length,
          text ? 'ok' : (parsed.error ?? 'empty'),
          Date.now(),
        )
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return text.length > 0
  }

  private forget(path: string): void {
    this.db.prepare('DELETE FROM chunks WHERE path = ?').run(path)
    this.db.prepare('DELETE FROM files WHERE path = ?').run(path)
  }

  search(
    query: string,
    limit = 8,
    pathContains = '',
  ): {
    hits: { path: string; idx: number; title: string; snippet: string; score: number }[]
    total: number
  } {
    const stmt = this.db.prepare(`
      SELECT path, idx, title, snippet(chunks, 3, '[', ']', ' … ', 28) AS snippet, bm25(chunks, 0, 0, 3.0, 1.0) AS score
      FROM chunks WHERE chunks MATCH ? AND (? = '' OR path LIKE ?) ORDER BY score LIMIT ?
    `)
    const like = pathContains ? `%${pathContains}%` : '%'
    type Row = { path: string; idx: number; title: string; snippet: string; score: number }
    let rows: Row[] = []
    for (const mode of ['and', 'or'] as const) {
      const q = ftsQuery(query, mode)
      if (!q) break
      try {
        rows = stmt.all(q, pathContains, like, limit * 4) as unknown as Row[]
      } catch {
        rows = []
      }
      if (rows.length) break
    }
    // at most two passages per file so one long document cannot crowd out the rest
    const perFile = new Map<string, number>()
    const hits: Row[] = []
    for (const r of rows) {
      const n = perFile.get(r.path) ?? 0
      if (n >= 2) continue
      perFile.set(r.path, n + 1)
      hits.push(r)
      if (hits.length >= limit) break
    }
    return { hits, total: rows.length }
  }

  private allowed(path: string): boolean {
    if (this.db.prepare('SELECT 1 FROM files WHERE path = ?').get(path)) return true
    return this.roots.some((r) => path === r || path.startsWith(r.endsWith('/') ? r : `${r}/`))
  }

  async read(rawPath: string): Promise<{ title: string; text: string } | null> {
    const path = expandHome(rawPath)
    if (!this.allowed(path))
      throw new Error(`${displayPath(path)} is outside the knowledge base folders`)
    const rows = this.db
      .prepare('SELECT title, body FROM chunks WHERE path = ? ORDER BY idx')
      .all(path) as unknown as { title: string; body: string }[]
    if (rows.length) return { title: rows[0]!.title, text: rows.map((r) => r.body).join('\n\n') }
    if (!existsSync(path)) return null
    const parsed = await parseFileToText(path)
    if (!parsed.ok || !parsed.text) throw new Error(parsed.error ?? 'no text in this file')
    return { title: titleOf(parsed.text, path), text: parsed.text }
  }

  /** readable files indexed after `sinceMs`, newest first (digest input); digests themselves are skipped */
  recentFiles(sinceMs: number, limit = 20): FileRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM files WHERE status = 'ok' AND indexed_at >= ? ORDER BY indexed_at DESC LIMIT ?`,
        )
        .all(sinceMs, limit * 2) as unknown as FileRow[]
    )
      .filter((r) => !/(^|\/)digest-\d{4}-\d{2}-\d{2}(-\d+)?\.md$/.test(r.path))
      .slice(0, limit)
  }

  list(pathContains = '', limit = 50): FileRow[] {
    return this.db
      .prepare(`SELECT * FROM files WHERE (? = '' OR path LIKE ?) ORDER BY mtime DESC LIMIT ?`)
      .all(pathContains, pathContains ? `%${pathContains}%` : '%', limit) as unknown as FileRow[]
  }

  async addNote(title: string, body: string, tags: string[] = []): Promise<string> {
    const date = new Date().toISOString().slice(0, 10)
    const slug = slugify(title) || 'note'
    let path = join(this.opts.notesDir, `${date}-${slug}.md`)
    for (let n = 2; existsSync(path); n++)
      path = join(this.opts.notesDir, `${date}-${slug}-${n}.md`)
    const front = [
      '---',
      `title: ${title.replace(/\n/g, ' ')}`,
      `created: ${new Date().toISOString()}`,
      ...(tags.length
        ? [
            `tags: [${tags
              .map((t) => t.trim())
              .filter(Boolean)
              .join(', ')}]`,
          ]
        : []),
      '---',
      '',
    ].join('\n')
    await writeFile(path, `${front}# ${title}\n\n${body.trim()}\n`, 'utf8')
    await this.indexFile(path)
    return path
  }

  async readPdfUrl(url: string): Promise<string> {
    if (!this.opts.fetchPdf) throw new Error('PDF download is not available here')
    const bytes = await this.opts.fetchPdf(url)
    if (!bytes) throw new Error('Could not download the PDF (blocked or unreachable)')
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('The URL did not return a PDF')
    return pdfToText(new Uint8Array(bytes))
  }

  status(): {
    roots: string[]
    notesDir: string
    files: number
    chunks: number
    lastScan: string | null
    scanning: boolean
    watching: boolean
    last: ScanSummary | null
  } {
    const last = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('lastScan') as
      { value: string } | undefined
    return {
      roots: this.roots,
      notesDir: this.opts.notesDir,
      files: this.count('files'),
      chunks: this.count('chunks'),
      lastScan: last?.value ?? null,
      scanning: this.scanning !== null,
      watching: this.watchers.length > 0,
      last: this.lastScan,
    }
  }

  /** forget everything and read every file again */
  async reindex(): Promise<ScanSummary> {
    this.db.exec('DELETE FROM chunks; DELETE FROM files;')
    return this.scan()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    for (const w of this.watchers.splice(0)) w.close()
    this.db.close()
  }
}

// ── the MCP server on top ─────────────────────────────────

function chunked(header: string, text: string, offset: number, maxChars: number): string {
  const total = text.length
  const piece = text.slice(offset, offset + maxChars)
  const rest = total - (offset + piece.length)
  const from = offset ? ` (from ${offset})` : ''
  const more =
    rest > 0
      ? `\n\n[truncated: ${rest} more characters — call again with offset=${offset + piece.length}]`
      : ''
  return `${header}Length: ${total} characters${from}\n\n${piece}${more}`
}

export function createKbServer(kb: KnowledgeBase): HostedServer {
  const ensure = (ctx: HostedContext) => {
    const raw = ctx.env.KB_ROOTS
    if (raw && kb.setRoots(raw.split(/[;:\n]/))) void kb.scan().catch(() => {})
  }
  const tools: HostedTool[] = [
    {
      name: 'kb_search',
      description:
        "Search the user's own documents and notes (the knowledge base: their document folders, indexed locally). Returns the best matching passages with the file path. Use kb_read on a path for the full text, and name the file when you use its content. Quote a phrase with double quotes for an exact match.",
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search words or "an exact phrase" (any language)',
          },
          limit: { type: 'integer', description: '1–20 passages, default 8' },
          path_contains: {
            type: 'string',
            description: 'Only files whose path contains this text',
          },
        },
        required: ['query'],
      },
      run: (args, ctx) => {
        ensure(ctx)
        const query = String(args.query ?? '').trim()
        if (!query) return textResult('query must not be empty', true)
        const limit = clamp(Number(args.limit) || 8, 1, 20)
        const { hits, total } = kb.search(query, limit, String(args.path_contains ?? '').trim())
        if (!hits.length) {
          const st = kb.status()
          return `No passages match "${query}" (${st.files} files indexed from ${st.roots.map(displayPath).join(', ')}).`
        }
        const lines = [`Passages matching "${query}" (${total} matching chunks):`]
        hits.forEach((h, i) => {
          lines.push(
            `${i + 1}. ${h.title} — ${displayPath(h.path)} (part ${h.idx + 1})`,
            `   ${h.snippet.replace(/\s+/g, ' ')}`,
          )
        })
        lines.push(
          '',
          'Use kb_read with the path for the full text; name the file when you use its content.',
        )
        return lines.join('\n')
      },
    },
    {
      name: 'kb_read',
      description:
        'Read the full text of a file in the knowledge base (any format the index supports: docx, pptx, xlsx, pdf, md, txt, csv…). Long files come in chunks: call again with offset.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path as shown by kb_search or kb_list (~ allowed)',
          },
          offset: { type: 'integer', description: 'Start position, default 0' },
          max_chars: { type: 'integer', description: '500–40000, default 12000' },
        },
        required: ['path'],
      },
      run: async (args, ctx) => {
        ensure(ctx)
        const path = String(args.path ?? '').trim()
        if (!path) return textResult('path must not be empty', true)
        const doc = await kb.read(path)
        if (!doc) return textResult(`${displayPath(expandHome(path))} does not exist`, true)
        return chunked(
          `Title: ${doc.title}\nPath: ${displayPath(expandHome(path))}\n`,
          doc.text,
          Math.max(0, Number(args.offset) || 0),
          clamp(Number(args.max_chars) || 12_000, 500, 40_000),
        )
      },
    },
    {
      name: 'kb_list',
      description: 'List indexed files, newest first, optionally filtered by a path fragment.',
      inputSchema: {
        type: 'object',
        properties: {
          path_contains: { type: 'string' },
          limit: { type: 'integer', description: '1–200, default 50' },
        },
      },
      run: (args, ctx) => {
        ensure(ctx)
        const rows = kb.list(
          String(args.path_contains ?? '').trim(),
          clamp(Number(args.limit) || 50, 1, 200),
        )
        if (!rows.length) return 'No indexed files match.'
        return rows
          .map(
            (r) =>
              `${displayPath(r.path)} — ${r.title} (${r.kind}, ${Math.round(r.chars / 1000)}k chars, modified ${new Date(r.mtime).toISOString().slice(0, 10)})`,
          )
          .join('\n')
      },
    },
    {
      name: 'kb_add_note',
      description:
        "Save a Markdown note into the user's knowledge base notes folder (findings, summaries, decisions). It is indexed at once and searchable with kb_search.",
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string', description: 'Markdown body; include sources' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'body'],
      },
      run: async (args, ctx) => {
        ensure(ctx)
        const title = String(args.title ?? '').trim()
        const body = String(args.body ?? '').trim()
        if (!title || !body) return textResult('title and body are required', true)
        const tags = Array.isArray(args.tags) ? args.tags.map(String) : []
        const path = await kb.addNote(title, body, tags)
        return `Note saved as ${displayPath(path)} and indexed.`
      },
    },
    {
      name: 'kb_status',
      description: 'What the knowledge base covers: folders, file and passage counts, last scan.',
      inputSchema: { type: 'object', properties: {} },
      run: (_args, ctx) => {
        ensure(ctx)
        const s = kb.status()
        return [
          `Folders: ${s.roots.map(displayPath).join(', ')}`,
          `Notes folder: ${displayPath(s.notesDir)}`,
          `Indexed: ${s.files} files, ${s.chunks} passages`,
          `Last scan: ${s.lastScan ?? 'never'}${s.scanning ? ' (scanning now)' : ''}${s.watching ? ', watching for changes' : ''}`,
        ].join('\n')
      },
    },
    {
      name: 'kb_reindex',
      description:
        'Rebuild the whole index from scratch (slow on big folders). Normally not needed: changes are picked up automatically.',
      inputSchema: { type: 'object', properties: {} },
      run: async (_args, ctx) => {
        ensure(ctx)
        const s = await kb.reindex()
        return `Reindexed: ${s.files} files, ${s.chunks} passages in ${Math.round(s.ms / 1000)} s (${s.unreadable} unreadable).`
      },
    },
    {
      name: 'pdf_read_url',
      description:
        'Download a PDF from an http(s) URL and return its text (the web read_page tool cannot read PDFs). Long documents come in chunks: call again with offset.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          offset: { type: 'integer', description: 'Start position, default 0' },
          max_chars: { type: 'integer', description: '500–40000, default 12000' },
        },
        required: ['url'],
      },
      run: async (args) => {
        const url = String(args.url ?? '').trim()
        if (!/^https?:\/\//i.test(url)) return textResult('url must be an http(s) URL', true)
        const text = await kb.readPdfUrl(url)
        if (!text.trim())
          return textResult('The PDF has no extractable text (scanned images?)', true)
        return chunked(
          `Source: ${url}\n`,
          text,
          Math.max(0, Number(args.offset) || 0),
          clamp(Number(args.max_chars) || 12_000, 500, 40_000),
        )
      },
    },
  ]
  return { name: 'kb', version: '1.0.0', tools }
}
