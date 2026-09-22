import { afterEach, describe, expect, it } from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  chunkText,
  createKbServer,
  discoverDriveDesktopRoots,
  ftsQuery,
  KnowledgeBase,
} from '../src/main/hosted/kb'

/**
 * The knowledge base: indexing, incremental rescans, search with snippets,
 * notes, reads, and the MCP tools on top — driven directly, no HTTP.
 */
const DOC_FIXTURE = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'packages',
  'file-parse',
  'tests',
  'fixtures',
  'legacy-sample.doc',
)

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'docs')
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(
    join(root, 'notes.md'),
    '# Regenerativt lantbruk\n\nMarkkol och jordhälsa mäts med MRV-metoder.\n\nEn andra paragraf om täckgrödor.\n',
  )
  writeFileSync(join(root, 'data.csv'), 'year,carbon\n2024,1.5\n2025,1.7\n')
  writeFileSync(
    join(root, 'sub', 'report.txt'),
    'Quarterly report: the sandworm pilot exceeded targets.',
  )
  writeFileSync(join(root, '.hidden.md'), 'secret hidden note about spice')
  writeFileSync(join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  if (existsSync(DOC_FIXTURE)) copyFileSync(DOC_FIXTURE, join(root, 'legacy-sample.doc'))
  const kb = new KnowledgeBase({
    dbPath: join(dir, 'kb', 'index.sqlite'),
    roots: [root],
    notesDir: join(dir, 'kb-notes'),
    watch: false,
    // .pdf URLs answer with HTML (not a PDF), everything else is unreachable
    fetchPdf: async (url) => (url.endsWith('.pdf') ? Buffer.from('<html>not a pdf</html>') : null),
  })
  cleanup.push(() => kb.close())
  return { dir, root, kb }
}

describe('KnowledgeBase', () => {
  it('indexes supported files, skips hidden and binary ones, and searches with snippets', async () => {
    const { root, kb } = setup()
    const s = await kb.start()
    const expected = existsSync(DOC_FIXTURE) ? 4 : 3
    expect(s.added).toBe(expected)
    expect(kb.status().files).toBe(expected)
    const { hits } = kb.search('markkol')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.path).toBe(join(root, 'notes.md'))
    expect(hits[0]!.title).toBe('Regenerativt lantbruk')
    expect(hits[0]!.snippet).toContain('[Markkol]')
    // hidden files are not indexed
    expect(kb.search('spice').hits).toHaveLength(0)
    // prefix matching and diacritics-insensitive matching
    expect(kb.search('jordhals').hits).toHaveLength(1)
    expect(kb.search('sandworm pilot').hits[0]!.path).toBe(join(root, 'sub', 'report.txt'))
    if (existsSync(DOC_FIXTURE)) {
      const doc = kb.list('legacy-sample')[0]
      expect(doc?.kind).toBe('doc')
      expect(doc?.chars).toBeGreaterThan(0)
    }
  })

  it('rescans incrementally: changed files are re-read, deleted files leave the index', async () => {
    const { root, kb } = setup()
    await kb.start()
    const notes = join(root, 'notes.md')
    // mtime granularity: make the change unmistakable in size too
    writeFileSync(notes, readFileSync(notes, 'utf8') + '\nEn ny rad om sandmaskar.\n')
    unlinkSync(join(root, 'sub', 'report.txt'))
    const s = await kb.scan()
    expect(s.updated).toBe(1)
    expect(s.removed).toBe(1)
    expect(kb.search('sandmaskar').hits[0]!.path).toBe(notes)
    expect(kb.search('sandworm').hits).toHaveLength(0)
    const again = await kb.scan()
    expect([again.added, again.updated, again.removed]).toEqual([0, 0, 0])
  })

  it('saves notes into the notes folder and indexes them at once', async () => {
    const { dir, kb } = setup()
    await kb.start()
    const path = await kb.addNote(
      'Möte med Palle: MRV-beslut',
      'Vi valde **metod B**.\n\nKälla: protokoll.',
      ['möte', 'mrv'],
    )
    expect(path).toBe(
      join(
        dir,
        'kb-notes',
        `${new Date().toISOString().slice(0, 10)}-mote-med-palle-mrv-beslut.md`,
      ),
    )
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('title: Möte med Palle: MRV-beslut')
    expect(text).toContain('tags: [möte, mrv]')
    expect(kb.search('"metod B"').hits[0]!.path).toBe(path)
    const second = await kb.addNote('Möte med Palle: MRV-beslut', 'again')
    expect(second).toMatch(/-2\.md$/)
  })

  it('reads full text only inside the roots', async () => {
    const { root, kb, dir } = setup()
    await kb.start()
    const doc = await kb.read(join(root, 'notes.md'))
    expect(doc?.title).toBe('Regenerativt lantbruk')
    expect(doc?.text).toContain('täckgrödor')
    writeFileSync(join(dir, 'outside.txt'), 'not yours')
    await expect(kb.read(join(dir, 'outside.txt'))).rejects.toThrow(/outside the knowledge base/)
    expect(await kb.read(join(root, 'missing.txt'))).toBeNull()
  })

  it('exposes the MCP tools with readable output', async () => {
    const { root, kb } = setup()
    await kb.start()
    const tools = createKbServer(kb).tools
    const ctx = { env: {}, log: () => {} }
    const run = (name: string, args: Record<string, unknown> = {}) =>
      tools.find((t) => t.name === name)!.run(args, ctx)
    expect(tools.map((t) => t.name)).toEqual([
      'kb_search',
      'kb_read',
      'kb_list',
      'kb_add_note',
      'kb_status',
      'kb_reindex',
      'pdf_read_url',
    ])
    const search = String(await run('kb_search', { query: 'täckgrödor' }))
    expect(search).toContain('1. Regenerativt lantbruk —')
    expect(search).toContain('notes.md (part 1)')
    expect(search).toContain('[täckgrödor]')
    expect(String(await run('kb_search', { query: 'nothing-like-this-xyz' }))).toContain(
      'No passages match',
    )
    const read = String(await run('kb_read', { path: join(root, 'notes.md'), max_chars: 500 }))
    expect(read).toContain('Title: Regenerativt lantbruk')
    expect(read).toContain('MRV-metoder')
    const status = String(await run('kb_status'))
    expect(status).toContain('Indexed: ')
    expect(status).toContain(root)
    const list = String(await run('kb_list', { path_contains: 'data' }))
    expect(list).toContain('data.csv')
    // tools may throw; the host turns that into an error result for the model
    await expect(run('pdf_read_url', { url: 'https://example.org/x.html' })).rejects.toThrow(
      /Could not download/,
    )
    await expect(run('pdf_read_url', { url: 'https://example.org/x.pdf' })).rejects.toThrow(
      /did not return a PDF/,
    )
  })

  it('env KB_ROOTS adds folders', async () => {
    const { dir, kb } = setup()
    await kb.start()
    const extra = join(dir, 'extra')
    mkdirSync(extra)
    writeFileSync(join(extra, 'more.txt'), 'A completely separate folder about Caladan.')
    const tools = createKbServer(kb).tools
    const status = String(
      await tools
        .find((t) => t.name === 'kb_status')!
        .run({}, { env: { KB_ROOTS: extra }, log: () => {} }),
    )
    expect(status).toContain(extra)
    await kb.scan()
    expect(kb.search('Caladan').hits[0]!.path).toBe(join(extra, 'more.txt'))
  })
})

describe('helpers', () => {
  it('discovers Google Drive for Desktop mirrors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    mkdirSync(join(dir, 'GoogleDrive-a@b.se', 'My Drive'), { recursive: true })
    mkdirSync(join(dir, 'GoogleDrive-a@b.se', 'Shared drives'), { recursive: true })
    mkdirSync(join(dir, 'OneDrive-Personal'), { recursive: true })
    expect(discoverDriveDesktopRoots(dir)).toEqual([
      join(dir, 'GoogleDrive-a@b.se', 'My Drive'),
      join(dir, 'GoogleDrive-a@b.se', 'Shared drives'),
    ])
    expect(discoverDriveDesktopRoots(join(dir, 'missing'))).toEqual([])
  })

  it('chunks by paragraph and splits long paragraphs at whitespace', () => {
    const chunks = chunkText(`${'a '.repeat(900)}\n\nshort\n\n${'b'.repeat(50)}`, 200)
    expect(chunks.every((c) => c.length <= 200)).toBe(true)
    expect(chunks.at(-1)).toBe(`short\n\n${'b'.repeat(50)}`)
  })
  it('builds FTS queries with phrases, prefixes and modes', () => {
    expect(ftsQuery('soil "carbon credits" MRV', 'and')).toBe('"carbon credits" "soil"* "MRV"')
    expect(ftsQuery('soil carbon', 'or')).toBe('"soil"* OR "carbon"*')
    expect(ftsQuery('a', 'and')).toBe('')
  })
})
