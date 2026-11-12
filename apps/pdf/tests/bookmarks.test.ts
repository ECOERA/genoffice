import { describe, expect, it } from 'vitest'
import {
  BOOKMARKS_KEY,
  MAX_BOOKMARK_FILES,
  loadBookmarks,
  moveBookmarks,
  remapBookmarks,
  saveBookmarks,
  shiftBookmarks,
} from '../src/renderer/bookmarks'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

describe('page bookmarks', () => {
  it('round-trips sorted, de-duplicated pages per file', () => {
    const s = memoryStorage()
    saveBookmarks('/a.pdf', [4, 1, 4], s)
    saveBookmarks('/b.pdf', [0], s)
    expect(loadBookmarks('/a.pdf', s)).toEqual([1, 4])
    expect(loadBookmarks('/b.pdf', s)).toEqual([0])
    expect(loadBookmarks('/c.pdf', s)).toEqual([])
  })

  it('removes the entry when the last bookmark is cleared', () => {
    const s = memoryStorage()
    saveBookmarks('/a.pdf', [2], s)
    saveBookmarks('/a.pdf', [], s)
    expect(JSON.parse(s.getItem(BOOKMARKS_KEY)!)).toEqual({})
  })

  it('ignores corrupted storage', () => {
    const s = memoryStorage()
    s.setItem(BOOKMARKS_KEY, '{"/a.pdf":{"pages":[1,"x",-2,1.5,3]},"/b.pdf":7}')
    expect(loadBookmarks('/a.pdf', s)).toEqual([1, 3])
    expect(loadBookmarks('/b.pdf', s)).toEqual([])
    s.setItem(BOOKMARKS_KEY, 'not json')
    expect(loadBookmarks('/a.pdf', s)).toEqual([])
  })

  it('prunes the least recently touched files', () => {
    const s = memoryStorage()
    for (let i = 0; i <= MAX_BOOKMARK_FILES; i++) saveBookmarks(`/f${i}.pdf`, [1], s, i)
    expect(loadBookmarks('/f0.pdf', s)).toEqual([])
    expect(loadBookmarks(`/f${MAX_BOOKMARK_FILES}.pdf`, s)).toEqual([1])
  })

  it('follows a renamed file', () => {
    const s = memoryStorage()
    saveBookmarks('/old.pdf', [3], s)
    moveBookmarks('/old.pdf', '/new.pdf', s)
    expect(loadBookmarks('/old.pdf', s)).toEqual([])
    expect(loadBookmarks('/new.pdf', s)).toEqual([3])
  })

  it('remaps across a save that reordered and deleted pages', () => {
    // Old pages 0..4; page 1 deleted; new order 4, 0, 2, 3
    const pageMap = new Map([4, 0, 2, 3].map((orig, i) => [orig, i]))
    expect(remapBookmarks([0, 1, 4], pageMap)).toEqual([0, 1])
  })

  it('shifts bookmarks after inserted pages', () => {
    expect(shiftBookmarks([0, 2, 5], 2, 3)).toEqual([0, 2, 8])
  })
})
