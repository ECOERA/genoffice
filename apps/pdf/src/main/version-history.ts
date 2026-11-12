/**
 * Local version history for PDFs edited in place.
 *
 * Every in-place write (Save, autosave, page operations) keeps a snapshot on
 * this device so the reader can open or restore an earlier state. The first
 * write also snapshots the untouched file as the "Original". Snapshots live
 * under `<userData>/pdf-versions/<hash of path>/` beside an `index.json`; the
 * PDF itself is never modified by this module.
 *
 * Rules that keep the store bounded:
 * - files over MAX_VERSION_FILE_BYTES are not versioned;
 * - writes within COALESCE_MS of the previous snapshot fold into it (autosave
 *   runs every 30 s, and one editing session should read as one version);
 * - at most MAX_VERSIONS snapshots per file; the Original is kept and the
 *   oldest of the rest is dropped.
 *
 * History is best effort: every failure is swallowed (and logged), because a
 * history problem must never fail or block the save itself.
 *
 * Idea from Folio's version history (https://github.com/Forward-Future/folio,
 * MIT) — see NOTICE.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PdfVersionChange, PdfVersionEntry, SavePdfRequest } from '../shared/ipc'

export const MAX_VERSION_FILE_BYTES = 50 * 1024 * 1024
export const MAX_VERSIONS = 25
export const COALESCE_MS = 2 * 60 * 1000
/** Text samples in a change summary are display-only; cap them so the index stays small */
const MAX_TEXT_SAMPLE = 200
const MAX_CHANGES_PER_VERSION = 50

interface IndexFile {
  path: string
  next: number
  versions: PdfVersionEntry[]
}

export class PdfVersionStore {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  private dirFor(path: string): string {
    return join(this.root, createHash('sha256').update(path).digest('hex').slice(0, 32))
  }

  private snapshotPath(path: string, n: number): string {
    return join(this.dirFor(path), `v${n}.pdf`)
  }

  private async readIndex(path: string): Promise<IndexFile | null> {
    try {
      const parsed = JSON.parse(await readFile(join(this.dirFor(path), 'index.json'), 'utf8')) as
        IndexFile | undefined
      if (!parsed || parsed.path !== path || !Array.isArray(parsed.versions)) return null
      return parsed
    } catch {
      return null
    }
  }

  private async writeIndex(index: IndexFile): Promise<void> {
    const dir = this.dirFor(index.path)
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `index.json.${process.pid}.tmp`)
    await writeFile(tmp, JSON.stringify(index))
    await rename(tmp, join(dir, 'index.json'))
  }

  private async versionable(path: string): Promise<boolean> {
    try {
      const s = await stat(path)
      return s.isFile() && s.size <= MAX_VERSION_FILE_BYTES
    } catch {
      return false
    }
  }

  /** Call right before `path` is overwritten: snapshots the untouched file once, as the Original. */
  async beforeWrite(path: string): Promise<void> {
    try {
      if ((await this.readIndex(path)) || !(await this.versionable(path))) return
      const index: IndexFile = { path, next: 2, versions: [] }
      await mkdir(this.dirFor(path), { recursive: true })
      await copyFile(path, this.snapshotPath(path, 1))
      const { size } = await stat(path)
      index.versions.push({ n: 1, createdAt: this.now(), size, changes: [], original: true })
      await this.writeIndex(index)
    } catch (err) {
      console.warn('[pdf] version history: could not keep the original', err)
    }
  }

  /** Call right after `path` was written: snapshots the new bytes with a summary of what changed. */
  async afterWrite(path: string, changes: PdfVersionChange[]): Promise<void> {
    try {
      if (!(await this.versionable(path))) return
      const index = (await this.readIndex(path)) ?? { path, next: 1, versions: [] }
      const { size } = await stat(path)
      const now = this.now()
      const latest = index.versions[index.versions.length - 1]
      const fold =
        latest &&
        !latest.original &&
        !latest.changes.some((c) => c.kind === 'restore') &&
        !changes.some((c) => c.kind === 'restore') &&
        now - latest.createdAt < COALESCE_MS
      await mkdir(this.dirFor(path), { recursive: true })
      if (fold) {
        await copyFile(path, this.snapshotPath(path, latest.n))
        latest.size = size
        latest.createdAt = now
        latest.changes = mergeChanges(latest.changes, changes)
      } else {
        const n = index.next
        await copyFile(path, this.snapshotPath(path, n))
        index.next = n + 1
        index.versions.push({ n, createdAt: now, size, changes: mergeChanges([], changes) })
        await this.prune(index)
      }
      await this.writeIndex(index)
    } catch (err) {
      console.warn('[pdf] version history: could not record the save', err)
    }
  }

  private async prune(index: IndexFile): Promise<void> {
    while (index.versions.length > MAX_VERSIONS) {
      const dropAt = index.versions.findIndex((v) => !v.original)
      if (dropAt < 0) return
      const [dropped] = index.versions.splice(dropAt, 1)
      await rm(this.snapshotPath(index.path, dropped!.n), { force: true })
    }
  }

  /** Newest first. */
  async list(path: string): Promise<PdfVersionEntry[]> {
    return [...((await this.readIndex(path))?.versions ?? [])].reverse()
  }

  /** The snapshot bytes, or null when that version is not (or no longer) stored. */
  async read(path: string, n: number): Promise<Buffer | null> {
    const index = await this.readIndex(path)
    if (!index?.versions.some((v) => v.n === n)) return null
    try {
      return await readFile(this.snapshotPath(path, n))
    } catch {
      return null
    }
  }

  async clear(path: string): Promise<void> {
    await rm(this.dirFor(path), { recursive: true, force: true })
  }

  /** The file was renamed or moved: its history follows it. */
  async move(from: string, to: string): Promise<void> {
    try {
      const index = await this.readIndex(from)
      if (!index || from === to) return
      await this.clear(to)
      await rename(this.dirFor(from), this.dirFor(to))
      await this.writeIndex({ ...index, path: to })
    } catch (err) {
      console.warn('[pdf] version history: could not follow a rename', err)
    }
  }
}

/** What a Save request changes, as version-history display entries. Skipped text edits are left out. */
export function summarizeSaveRequest(
  request: SavePdfRequest,
  skippedTextEdits: { pageIndex: number; oldText: string }[] = [],
): PdfVersionChange[] {
  const changes: PdfVersionChange[] = []
  const skipped = new Set(skippedTextEdits.map((s) => `${s.pageIndex}\u0000${s.oldText}`))
  for (const edit of request.textEdits ?? []) {
    if (skipped.has(`${edit.pageIndex}\u0000${edit.oldText}`)) continue
    changes.push({
      kind: 'text',
      page: edit.pageIndex + 1,
      before: sample(edit.oldText),
      after: sample(edit.newText),
    })
  }
  const counted: [PdfVersionChange['kind'], number][] = [
    ['textInsert', request.textInserts?.length ?? 0],
    ['image', request.imageEdits?.length ?? 0],
    [
      'annotations',
      (request.markups?.length ?? 0) +
        (request.drawings?.length ?? 0) +
        (request.annotDeletes?.length ?? 0) +
        (request.noteEdits?.length ?? 0),
    ],
    ['forms', (request.formValues?.length ?? 0) + (request.staticFormFills?.length ?? 0)],
    ['stamps', request.stamps?.length ?? 0],
    [
      'pages',
      (request.rotations?.length ?? 0) +
        (request.deletedPages?.length ?? 0) +
        (request.pageOrder ? 1 : 0),
    ],
    ['metadata', request.metadata ? 1 : 0],
  ]
  for (const [kind, count] of counted) {
    if (count > 0) changes.push({ kind, count } as PdfVersionChange)
  }
  return changes
}

const sample = (s: string) => (s.length > MAX_TEXT_SAMPLE ? `${s.slice(0, MAX_TEXT_SAMPLE)}…` : s)

/**
 * Fold `next` into `prev`: text edits are listed individually (latest wording
 * wins for the same page and original text); counted kinds add up.
 */
export function mergeChanges(
  prev: PdfVersionChange[],
  next: PdfVersionChange[],
): PdfVersionChange[] {
  const out = prev.map((c) => ({ ...c }))
  for (const c of next) {
    if (c.kind === 'text') {
      const same = out.find(
        (o): o is Extract<PdfVersionChange, { kind: 'text' }> =>
          o.kind === 'text' && o.page === c.page && o.after === c.before,
      )
      if (same) same.after = sample(c.after)
      else out.push({ ...c, before: sample(c.before), after: sample(c.after) })
    } else if (c.kind === 'restore') {
      out.push({ ...c })
    } else {
      const same = out.find((o) => o.kind === c.kind)
      if (same && 'count' in same && 'count' in c) same.count += c.count
      else out.push({ ...c })
    }
  }
  return out.slice(0, MAX_CHANGES_PER_VERSION)
}
