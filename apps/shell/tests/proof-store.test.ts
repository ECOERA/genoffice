/**
 * Storage for document proofs. The embedding tests drive a real .docx built by
 * the engine and re-open it with the engine, because the thing worth proving is
 * that a proof survives the package machinery — not that JSZip can write a file.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildBlankDocx, parseDocx, saveDocx } from '@genoffice/docx-engine'
import type { AnchorRecord, ProofRecord } from '@genoffice/doc-proof'
import {
  embedProof,
  loadProof,
  readEmbeddedProof,
  readSidecar,
  sidecarPathFor,
  writeSidecar,
} from '../src/main/proof-store'

const RECORD: ProofRecord = {
  version: 1,
  document: 'agreement.docx',
  contentHash: `0x${'ab'.repeat(32)}`,
  intent: 'approved',
  signedAt: '2026-10-03T09:00:00.000Z',
  signer: `0x${'11'.repeat(20)}`,
  signature: `0x${'cd'.repeat(65)}`,
  canonicalVersion: 1,
}

/** the usual stored shape: signed, not published */
const STORED = { record: RECORD, anchor: null } as const

const ANCHOR: AnchorRecord = {
  chainId: 8453,
  uid: `0x${'11'.repeat(32)}`,
  txHash: `0x${'22'.repeat(32)}`,
  attester: `0x${'33'.repeat(20)}`,
  anchoredAt: '2026-10-03T10:00:00.000Z',
}

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proof-store-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sidecar', () => {
  it('names the sidecar after the document', () => {
    expect(sidecarPathFor('/a/b/report.docx')).toBe('/a/b/report.docx.sig.json')
  })

  it('round-trips a record', async () => {
    const doc = join(dir, 'round-trip.docx')
    await writeSidecar(doc, STORED)
    expect(await readSidecar(doc)).toEqual(STORED)
  })

  it('is plain readable JSON, not an opaque blob', async () => {
    const doc = join(dir, 'readable.docx')
    await writeSidecar(doc, STORED)
    const raw = JSON.parse(await readFile(sidecarPathFor(doc), 'utf8')) as Record<string, unknown>
    expect(raw.signer).toBe(RECORD.signer)
    expect(raw.intent).toBe('approved')
  })

  it('reports no proof rather than throwing when there is no sidecar', async () => {
    expect(await readSidecar(join(dir, 'never-signed.docx'))).toBeNull()
  })

  it('rejects a corrupt sidecar instead of trusting it', async () => {
    const doc = join(dir, 'corrupt.docx')
    await writeFile(sidecarPathFor(doc), '{ not json', 'utf8')
    expect(await readSidecar(doc)).toBeNull()
  })

  it('rejects a structurally wrong sidecar', async () => {
    const doc = join(dir, 'wrong.docx')
    await writeFile(sidecarPathFor(doc), JSON.stringify({ ...RECORD, intent: 'notarised' }), 'utf8')
    expect(await readSidecar(doc)).toBeNull()
  })
})

describe('embedding in a .docx', () => {
  it('writes a proof that reads back out', async () => {
    const embedded = await embedProof(await buildBlankDocx(), STORED)
    expect(await readEmbeddedProof(embedded)).toEqual(STORED)
  })

  it('leaves the document openable by the engine', async () => {
    const embedded = await embedProof(await buildBlankDocx(), STORED)
    const parsed = await parseDocx(embedded)
    expect(parsed.blocks.length).toBeGreaterThan(0)
  })

  it('declares the part in [Content_Types].xml, or Word calls the file corrupt', async () => {
    const { default: JSZip } = await import('jszip')
    const embedded = await embedProof(await buildBlankDocx(), STORED)
    const zip = await JSZip.loadAsync(embedded)
    const types = await zip.file('[Content_Types].xml')!.async('string')
    expect(types).toContain('customXml/duneofficeProof.xml')
    // and the document relates it, so the package is well-formed
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
    expect(rels).toContain('duneofficeProof.xml')
  })

  it('survives a save through the engine', async () => {
    const embedded = await embedProof(await buildBlankDocx(), STORED)
    const parsed = await parseDocx(embedded)
    const blocks = parsed.blocks
      .filter((b) => !b.hidden && b.docxIndex !== null)
      .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! }))
    // force a real rewrite rather than the unchanged-bytes short circuit
    const saved = await saveDocx(parsed, blocks, { removePersonalInfo: true })
    expect(await readEmbeddedProof(saved)).toEqual(STORED)
  })

  it('replaces a previous proof instead of accumulating them', async () => {
    const once = await embedProof(await buildBlankDocx(), STORED)
    const second: ProofRecord = {
      ...RECORD,
      intent: 'reviewed',
      signedAt: '2026-10-04T09:00:00.000Z',
    }
    const twice = await embedProof(once, { record: second, anchor: null })
    expect(await readEmbeddedProof(twice)).toEqual({ record: second, anchor: null })
  })

  it('reports no proof for an unsigned document', async () => {
    expect(await readEmbeddedProof(await buildBlankDocx())).toBeNull()
  })

  it('reports no proof for bytes that are not a docx at all', async () => {
    expect(await readEmbeddedProof(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

describe('loadProof', () => {
  it('prefers the embedded proof, which travelled with the file', async () => {
    const doc = join(dir, 'both.docx')
    const sidecarOnly: ProofRecord = { ...RECORD, intent: 'received' }
    await writeSidecar(doc, { record: sidecarOnly, anchor: null })
    const embedded = await embedProof(await buildBlankDocx(), STORED)
    expect(await loadProof(doc, embedded)).toEqual(STORED)
  })

  it('falls back to the sidecar when the file carries nothing', async () => {
    const doc = join(dir, 'sidecar-only.docx')
    await writeSidecar(doc, STORED)
    expect(await loadProof(doc, await buildBlankDocx())).toEqual(STORED)
  })

  it('answers from the sidecar alone for formats with no embedding yet', async () => {
    const doc = join(dir, 'notes.md')
    await writeSidecar(doc, STORED)
    expect(await loadProof(doc, null)).toEqual(STORED)
  })

  it('returns null when the document was never signed', async () => {
    expect(await loadProof(join(dir, 'blank.docx'), await buildBlankDocx())).toBeNull()
  })
})

describe('anchors', () => {
  it('round-trips an anchor beside the record, in both places', async () => {
    const doc = join(dir, 'anchored.docx')
    const stored = { record: RECORD, anchor: ANCHOR }
    await writeSidecar(doc, stored)
    expect(await readSidecar(doc)).toEqual(stored)
    expect(await readEmbeddedProof(await embedProof(await buildBlankDocx(), stored))).toEqual(
      stored,
    )
  })

  it('keeps the anchor out of the signed record, where it would not belong', async () => {
    const doc = join(dir, 'anchor-shape.docx')
    await writeSidecar(doc, { record: RECORD, anchor: ANCHOR })
    const raw = JSON.parse(await readFile(sidecarPathFor(doc), 'utf8')) as Record<string, unknown>
    // flat: the record's own fields, plus a sibling anchor
    expect(raw.signature).toBe(RECORD.signature)
    expect(raw.anchor).toMatchObject({ chainId: 8453, uid: ANCHOR.uid })
  })

  it('reads a proof written before anchoring existed', async () => {
    // exactly what the previous version wrote: the flat record, no anchor key
    const doc = join(dir, 'legacy.docx')
    await writeFile(sidecarPathFor(doc), JSON.stringify(RECORD, null, 2), 'utf8')
    expect(await readSidecar(doc)).toEqual({ record: RECORD, anchor: null })
  })

  it('ignores a malformed anchor rather than rejecting the whole proof', async () => {
    const doc = join(dir, 'bad-anchor.docx')
    await writeFile(
      sidecarPathFor(doc),
      JSON.stringify({ ...RECORD, anchor: { chainId: 'base' } }),
      'utf8',
    )
    // the signature is still good; only the publication claim is unreadable
    expect(await readSidecar(doc)).toEqual({ record: RECORD, anchor: null })
  })

  it('refuses an anchor on a chain it does not know', async () => {
    const doc = join(dir, 'odd-chain.docx')
    await writeFile(
      sidecarPathFor(doc),
      JSON.stringify({ ...RECORD, anchor: { ...ANCHOR, chainId: 999 } }),
      'utf8',
    )
    expect((await readSidecar(doc))?.anchor).toBeNull()
  })
})
