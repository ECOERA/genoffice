import { describe, expect, it } from 'vitest'
import { createDriveServer, type DriveLike } from '../src/main/hosted/drive'
import type { GoogleDriveFileEntry } from '../src/shared/home-api'

/** The Drive tools around a fake service: search listing, chunked reads that index, open, signed-out. */

const FILE: GoogleDriveFileEntry = {
  id: 'f1',
  name: 'MRV-metod 2026',
  kind: 'docs',
  ext: 'docx',
  mimeType: 'application/vnd.google-apps.document',
  googleNative: true,
  modifiedMs: Date.parse('2026-09-20T10:00:00Z'),
  size: 30_000,
  webViewLink: 'https://docs.google.com/document/d/f1',
} as GoogleDriveFileEntry

function fake(signedIn = true) {
  const calls: string[] = []
  const drive: DriveLike = {
    signedIn: () => signedIn,
    search: async (q, o) => {
      calls.push(`search:${q}:${o.fullText}:${o.max}`)
      return q === 'nothing' ? [] : [FILE]
    },
    fetchToCache: async (id) => {
      calls.push(`fetch:${id}`)
      return { path: `/cache/${id}/MRV-metod 2026.docx` }
    },
    open: async (id) => {
      calls.push(`open:${id}`)
      return { path: `/cache/${id}/MRV-metod 2026.docx` }
    },
  }
  const indexed: string[] = []
  const tools = createDriveServer({
    drive: () => drive,
    parse: async (path) =>
      path.includes('f1')
        ? { ok: true, text: 'Metoden bygger på '.repeat(100) }
        : { ok: false, text: '', error: 'unsupported' },
    index: async (path) => {
      indexed.push(path)
    },
  }).tools
  const ctx = { env: {}, log: () => {} }
  const run = (name: string, args: Record<string, unknown>) =>
    tools.find((t) => t.name === name)!.run(args, ctx)
  return { run, calls, indexed }
}

describe('drive MCP tools', () => {
  it('searches, reads in chunks (indexing the copy) and opens', async () => {
    const { run, calls, indexed } = fake()
    const s = String(await run('drive_search', { query: 'MRV', max: 5 }))
    expect(s).toContain('1. MRV-metod 2026 (Google docs · 29 KB, modified 2026-09-20) — id f1')
    expect(calls[0]).toBe('search:MRV:true:5')
    expect(String(await run('drive_search', { query: 'nothing', names_only: true }))).toContain(
      'Nothing in Google Drive matches',
    )
    expect(calls[1]).toBe('search:nothing:false:10')
    const r = String(await run('drive_read', { file_id: 'f1', max_chars: 500 }))
    expect(r).toContain('File: MRV-metod 2026.docx (Drive id f1)')
    expect(r).toContain('Length: 1800 characters')
    expect(r).toContain('[truncated: 1300 more characters — call drive_read again with offset=500]')
    expect(calls.at(-1)).toBe('fetch:f1')
    await new Promise((r) => setTimeout(r, 5))
    expect(indexed).toEqual(['/cache/f1/MRV-metod 2026.docx'])
    const bad = await run('drive_read', { file_id: 'f2' })
    expect(bad).toMatchObject({ isError: true })
    expect(String(await run('drive_open', { file_id: 'f1' }))).toBe(
      'Opened MRV-metod 2026.docx in the editor.',
    )
    expect(calls.at(-1)).toBe('open:f1')
  })

  it('explains when Drive is not signed in', async () => {
    const { run, calls } = fake(false)
    for (const [name, args] of [
      ['drive_search', { query: 'x' }],
      ['drive_read', { file_id: 'f1' }],
      ['drive_open', { file_id: 'f1' }],
    ] as const) {
      const r = await run(name, args)
      expect(r).toMatchObject({ isError: true })
      expect((r as { text: string }).text).toContain('Not signed in to Google Drive')
    }
    expect(calls).toEqual([])
  })
})
