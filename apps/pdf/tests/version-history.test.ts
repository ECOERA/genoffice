// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COALESCE_MS,
  MAX_VERSIONS,
  PdfVersionStore,
  mergeChanges,
  summarizeSaveRequest,
} from '../src/main/version-history'
import type { SavePdfRequest } from '../src/shared/ipc'

let dir: string
let clock: number
let store: PdfVersionStore
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pdf-versions-'))
  clock = 1_000_000
  store = new PdfVersionStore(join(dir, 'store'), () => clock)
  file = join(dir, 'doc.pdf')
  await writeFile(file, 'original')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** One in-place save, the way the main process wraps it */
async function save(content: string, changes = [{ kind: 'annotations' as const, count: 1 }]) {
  await store.beforeWrite(file)
  await writeFile(file, content)
  await store.afterWrite(file, changes)
}

describe('PdfVersionStore', () => {
  it('keeps the untouched file as the Original, then each save', async () => {
    await save('v2')
    clock += COALESCE_MS + 1
    await save('v3')
    const list = await store.list(file)
    expect(list.map((v) => v.n)).toEqual([3, 2, 1])
    expect(list[2]!.original).toBe(true)
    expect((await store.read(file, 1))!.toString()).toBe('original')
    expect((await store.read(file, 3))!.toString()).toBe('v3')
  })

  it('folds saves made close together into one version', async () => {
    await save('a', [{ kind: 'annotations', count: 1 }])
    clock += 30_000
    await save('b', [{ kind: 'annotations', count: 2 }])
    const list = await store.list(file)
    expect(list.map((v) => v.n)).toEqual([2, 1])
    expect(list[0]!.changes).toEqual([{ kind: 'annotations', count: 3 }])
    expect((await store.read(file, 2))!.toString()).toBe('b')
  })

  it('never folds into a restore', async () => {
    await save('a')
    clock += 1000
    await save('original', [{ kind: 'restore', from: 1 } as never])
    clock += 1000
    await save('c')
    expect((await store.list(file)).map((v) => v.n)).toEqual([4, 3, 2, 1])
  })

  it('caps the number of versions but keeps the Original', async () => {
    for (let i = 0; i < MAX_VERSIONS + 5; i++) {
      clock += COALESCE_MS + 1
      await save(`s${i}`)
    }
    const list = await store.list(file)
    expect(list).toHaveLength(MAX_VERSIONS)
    expect(list[list.length - 1]!.original).toBe(true)
    expect((await store.read(file, 1))!.toString()).toBe('original')
    expect(await store.read(file, 2)).toBeNull()
  })

  it('follows a renamed file and can be cleared', async () => {
    await save('v2')
    const moved = join(dir, 'renamed.pdf')
    await writeFile(moved, await readFile(file))
    await store.move(file, moved)
    expect(await store.list(file)).toEqual([])
    expect((await store.list(moved)).map((v) => v.n)).toEqual([2, 1])
    await store.clear(moved)
    expect(await store.list(moved)).toEqual([])
  })

  it('does not version files it cannot read', async () => {
    await store.beforeWrite(join(dir, 'missing.pdf'))
    await store.afterWrite(join(dir, 'missing.pdf'), [])
    expect(await store.list(join(dir, 'missing.pdf'))).toEqual([])
  })
})

describe('change summaries', () => {
  it('lists text edits and counts the rest', () => {
    const request = {
      path: '/x.pdf',
      markups: [{}, {}],
      drawings: [{}],
      formValues: [],
      // sent with every save; empty means nothing was filled in
      staticFormFills: [],
      stamps: [],
      textEdits: [
        { pageIndex: 0, oldText: 'Helo', newText: 'Hello' },
        { pageIndex: 2, oldText: 'skip me', newText: 'x' },
      ],
      rotations: [{ pageIndex: 1, delta: 90 }],
      pageOrder: [1, 0],
    } as unknown as SavePdfRequest
    expect(summarizeSaveRequest(request, [{ pageIndex: 2, oldText: 'skip me' }])).toEqual([
      { kind: 'text', page: 1, before: 'Helo', after: 'Hello' },
      { kind: 'annotations', count: 3 },
      { kind: 'pages', count: 2 },
    ])
  })

  it('merges a second edit of the same text into one entry', () => {
    expect(
      mergeChanges(
        [{ kind: 'text', page: 1, before: 'a', after: 'b' }],
        [{ kind: 'text', page: 1, before: 'b', after: 'c' }],
      ),
    ).toEqual([{ kind: 'text', page: 1, before: 'a', after: 'c' }])
  })
})
