/**
 * Personal page bookmarks: the reader's own "come back to this page" marks,
 * kept on this device (they are not written into the PDF, unlike the PDF's
 * outline). Same storage shape as view-state.ts: one localStorage key holding a
 * path-keyed map with LRU pruning, so the store cannot grow without bound.
 *
 * Pages are stored as ORIGINAL (file) page indices. A save that deletes or
 * reorders pages rewrites the file, so `remapBookmarks` translates them to the
 * new file's indices.
 *
 * Idea from Folio (https://github.com/Forward-Future/folio, MIT) — see
 * NOTICE. Pure module — storage is injectable for tests.
 */

export const BOOKMARKS_KEY = 'genoffice-pdf-bookmarks'
export const MAX_BOOKMARK_FILES = 200

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
type Entry = { pages: number[]; at: number }

function readAll(storage: StorageLike): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(BOOKMARKS_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Entries come from disk and may be from an older build or corrupted — never trust them. */
function sanitize(entry: unknown): Entry | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  if (!Array.isArray(e.pages)) return null
  const pages = [
    ...new Set(
      e.pages.filter((p): p is number => typeof p === 'number' && Number.isInteger(p) && p >= 0),
    ),
  ].sort((a, b) => a - b)
  return { pages, at: typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : 0 }
}

export function loadBookmarks(path: string, storage: StorageLike = localStorage): number[] {
  if (!path) return []
  return sanitize(readAll(storage)[path])?.pages ?? []
}

export function saveBookmarks(
  path: string,
  pages: Iterable<number>,
  storage: StorageLike = localStorage,
  now: number = Date.now(),
): void {
  if (!path) return
  const all = readAll(storage)
  const list = [...new Set(pages)].sort((a, b) => a - b)
  if (list.length === 0) delete all[path]
  else all[path] = { pages: list, at: now } satisfies Entry
  const paths = Object.keys(all)
  if (paths.length > MAX_BOOKMARK_FILES) {
    const age = (p: string) => sanitize(all[p])?.at ?? -1
    paths.sort((a, b) => age(b) - age(a))
    for (const stale of paths.slice(MAX_BOOKMARK_FILES)) delete all[stale]
  }
  try {
    storage.setItem(BOOKMARKS_KEY, JSON.stringify(all))
  } catch {
    /* quota or disabled storage: bookmarks are a convenience, never block reading */
  }
}

/** Move a file's bookmarks to a new path (rename / Save As). */
export function moveBookmarks(from: string, to: string, storage: StorageLike = localStorage): void {
  if (!from || !to || from === to) return
  const pages = loadBookmarks(from, storage)
  if (pages.length === 0) return
  saveBookmarks(to, pages, storage)
  saveBookmarks(from, [], storage)
}

/**
 * Translate bookmarks across a save that rewrote the page list. `pageMap` maps
 * each old original index to its index in the saved file (deleted pages are
 * absent, so their bookmarks are dropped).
 */
export function remapBookmarks(
  pages: Iterable<number>,
  pageMap: ReadonlyMap<number, number>,
): number[] {
  const out: number[] = []
  for (const p of pages) {
    const next = pageMap.get(p)
    if (next !== undefined) out.push(next)
  }
  return out.sort((a, b) => a - b)
}

/** Pages were inserted after file index `after`: later bookmarks move down by `count`. */
export function shiftBookmarks(pages: Iterable<number>, after: number, count: number): number[] {
  return [...pages].map((p) => (p > after ? p + count : p)).sort((a, b) => a - b)
}
