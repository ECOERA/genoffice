/**
 * The claim this feature rests on: a signature survives re-saving the document
 * and breaks when the content actually changes. These tests drive the real
 * docx engine — parse, save, re-parse — rather than a model of it, because the
 * whole point of the canonical form is to absorb what that engine does to the
 * bytes on the way through.
 */
import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { buildBlankDocx, parseDocx, saveDocx } from '@genoffice/docx-engine'
import { canonicalFromBlocks, runsToText } from '../src/docx'
import { digestCanonical, STRIKE_OPEN } from '../src/canonical'
import { recordFrom, typedDataFor, verifyProof, type ProofMessage } from '../src/proof'

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
)

/** a blank document with the given paragraphs, through the real engine */
async function docWith(paragraphs: readonly string[]) {
  const blank = await buildBlankDocx()
  const parsed = await parseDocx(blank)
  const blocks = paragraphs.map((text, i) => ({
    ...parsed.blocks[0]!,
    id: `b${i}`,
    docxIndex: null,
    originalXml: null,
    type: 'paragraph' as const,
    runs: [{ text }],
  }))
  return { ...parsed, blocks }
}

async function digestOf(doc: Awaited<ReturnType<typeof docWith>>) {
  return digestCanonical(canonicalFromBlocks(doc.blocks))
}

/**
 * Save and reopen through the real engine. `removePersonalInfo` forces a full
 * rewrite: saveDocx short-circuits and returns the original bytes when nothing
 * changed, which would make a round-trip test prove nothing.
 */
async function roundTrip(parsed: Awaited<ReturnType<typeof parseDocx>>) {
  const blocks = parsed.blocks
    .filter((b) => !b.hidden && b.docxIndex !== null)
    .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! }))
  const bytes = await saveDocx(parsed, blocks, { removePersonalInfo: true })
  return parseDocx(bytes)
}

describe('runsToText', () => {
  it('joins runs before normalising, so run splitting cannot change the text', () => {
    const asOne = runsToText([{ text: 'shall not be liable' }])
    const asMany = runsToText([{ text: 'shall ' }, { text: 'not ' }, { text: 'be liable' }])
    expect(asMany).toBe(asOne)
  })

  it('fences struck-through runs, because striking text out changes the meaning', () => {
    const plain = runsToText([{ text: 'shall not' }])
    const struck = runsToText([{ text: 'shall ' }, { text: 'not', strike: true }])
    expect(struck).not.toBe(plain)
    expect(struck).toContain(STRIKE_OPEN)
  })

  it('ignores purely visual formatting', () => {
    const plain = runsToText([{ text: 'Total: 1000' }])
    const dressed = runsToText([
      { text: 'Total: ', bold: true },
      { text: '1000', italic: true, underline: true, styleId: 'Emphasis' },
    ])
    expect(dressed).toBe(plain)
  })

  it('treats no runs and empty runs alike', () => {
    expect(runsToText(undefined)).toBe('')
    expect(runsToText([])).toBe('')
    expect(runsToText([{ text: '' }])).toBe('')
  })
})

describe('a signature across a real save', () => {
  it('still verifies after the document is saved and reopened', async () => {
    const parsed = await parseDocx(await buildBlankDocx())
    const hash = digestCanonical(canonicalFromBlocks(parsed.blocks))

    const message: ProofMessage = {
      document: 'agreement.docx',
      contentHash: hash,
      intent: 'approved',
      signedAt: 1_790_000_000n,
      signer: account.address,
    }
    const record = recordFrom(message, await account.signTypedData(typedDataFor(message)))

    const reopened = await roundTrip(parsed)
    const afterSave = digestCanonical(canonicalFromBlocks(reopened.blocks))

    // the file was genuinely rewritten; the content digest did not move
    expect(afterSave).toBe(hash)
    await expect(verifyProof(record, afterSave)).resolves.toMatchObject({ ok: true })
  })

  it('survives two consecutive saves', async () => {
    const parsed = await parseDocx(await buildBlankDocx())
    const hash = digestCanonical(canonicalFromBlocks(parsed.blocks))
    const twice = await roundTrip(await roundTrip(parsed))
    expect(digestCanonical(canonicalFromBlocks(twice.blocks))).toBe(hash)
  })

  it('breaks when a word is changed', async () => {
    const before = await docWith(['Ecoera shall not be liable for delay.'])
    const after = await docWith(['Ecoera shall be liable for delay.'])
    expect(await digestOf(after)).not.toBe(await digestOf(before))
  })

  it('breaks when a paragraph is added', async () => {
    const before = await docWith(['Clause one.'])
    const after = await docWith(['Clause one.', 'Clause two.'])
    expect(await digestOf(after)).not.toBe(await digestOf(before))
  })

  it('breaks when a paragraph is removed', async () => {
    const before = await docWith(['Clause one.', 'Clause two.'])
    const after = await docWith(['Clause one.'])
    expect(await digestOf(after)).not.toBe(await digestOf(before))
  })

  it('breaks when paragraphs are reordered', async () => {
    const before = await docWith(['First.', 'Second.'])
    const after = await docWith(['Second.', 'First.'])
    expect(await digestOf(after)).not.toBe(await digestOf(before))
  })

  it('reports content-changed for an edited document, with the signature still sound', async () => {
    const original = await docWith(['Ecoera agrees to deliver 1,000 tonnes.'])
    const hash = await digestOf(original)
    const message: ProofMessage = {
      document: 'agreement.docx',
      contentHash: hash,
      intent: 'approved',
      signedAt: 1_790_000_000n,
      signer: account.address,
    }
    const record = recordFrom(message, await account.signTypedData(typedDataFor(message)))

    const edited = await docWith(['Ecoera agrees to deliver 100 tonnes.'])
    const result = await verifyProof(record, await digestOf(edited))

    expect(result).toMatchObject({ ok: false, reason: 'content-changed' })
    // the signer is still reported: the proof was genuine, the document moved on
    expect(result.record?.signer).toBe(account.address)
  })
})

describe('what the canonical form covers', () => {
  it('ignores whitespace differences a re-save can introduce', async () => {
    const tight = await docWith(['Delivery  by   2027.'])
    const loose = await docWith(['Delivery by 2027.'])
    expect(await digestOf(loose)).toBe(await digestOf(tight))
  })

  it('distinguishes a heading from a paragraph with the same words', async () => {
    const doc = await docWith(['Agreement'])
    const asParagraph = digestCanonical(canonicalFromBlocks(doc.blocks))
    const asHeading = digestCanonical(
      canonicalFromBlocks([{ ...doc.blocks[0]!, type: 'heading', level: 1 }]),
    )
    expect(asHeading).not.toBe(asParagraph)
  })

  it('gives an image a slot even when its data cannot be decoded', () => {
    const base = { id: 'x', docxIndex: null, originalXml: null } as const
    const withImage = canonicalFromBlocks([{ ...base, type: 'image', imageDataUrl: 'nonsense' }])
    expect(withImage.blocks).toEqual([{ k: 'img', sha: '' }])
    // removing it must still change the digest
    expect(digestCanonical(withImage)).not.toBe(digestCanonical({ v: 1, blocks: [] }))
  })

  it('hashes image content, so swapping a picture breaks the proof', () => {
    const base = { id: 'x', docxIndex: null, originalXml: null, type: 'image' as const }
    const png = (body: string) => `data:image/png;base64,${Buffer.from(body).toString('base64')}`
    const a = canonicalFromBlocks([{ ...base, imageDataUrl: png('chart-a') }])
    const b = canonicalFromBlocks([{ ...base, imageDataUrl: png('chart-b') }])
    expect(digestCanonical(a)).not.toBe(digestCanonical(b))
  })

  it('covers table cell text', () => {
    const base = { id: 't', docxIndex: null, originalXml: null, type: 'table' as const }
    const cells = (v: string) => ({ rows: [[{ paras: ['Year'] }, { paras: [v] }]] })
    const a = canonicalFromBlocks([{ ...base, table: cells('400') }])
    const b = canonicalFromBlocks([{ ...base, table: cells('4000') }])
    expect(digestCanonical(a)).not.toBe(digestCanonical(b))
  })

  it('covers passthrough previews, so a swapped chart does not slip through', () => {
    const base = { id: 'c', docxIndex: null, originalXml: null, type: 'passthrough' as const }
    const a = canonicalFromBlocks([{ ...base, previewText: 'Emissions 2026' }])
    const b = canonicalFromBlocks([{ ...base, previewText: 'Emissions 2027' }])
    expect(digestCanonical(a)).not.toBe(digestCanonical(b))
  })
})
