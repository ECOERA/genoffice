import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  asProofRecord,
  digestCanonical,
  normalizeText,
  recordFrom,
  serializeCanonical,
  typedDataFor,
  typedDataJson,
  verifyProof,
  type CanonicalDoc,
  type ProofMessage,
} from '../src/index'

/** a throwaway key; this is a test vector, never a wallet */
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const account = privateKeyToAccount(KEY)

/**
 * Named so the tests stay readable: Prettier rewrites \uXXXX escapes in string
 * literals to the characters themselves, and an invisible NBSP in a test tells
 * a later reader nothing about what is being checked.
 */
const NBSP = '\u00A0'
const EM_SPACE = '\u2003'
const THIN_SPACE = '\u2009'
const ZWSP = '\u200B'
const BOM = '\uFEFF'
/** "é" precomposed, and as "e" + combining acute — the same character, two encodings */
const E_ACUTE = '\u00E9'
const COMBINING_ACUTE = '\u0301'

const doc = (blocks: CanonicalDoc['blocks']): CanonicalDoc => ({ v: 1, blocks })

const SAMPLE = doc([
  { k: 'h', lvl: 1, t: 'Carbon removal agreement' },
  { k: 'p', t: 'Ecoera agrees to deliver 1,000 tonnes.' },
  { k: 'li', lvl: 1, t: 'Delivery by 2027-01-01' },
  {
    k: 'tbl',
    rows: [
      ['Year', 'Tonnes'],
      ['2026', '400'],
    ],
  },
])

async function sign(message: ProofMessage) {
  return account.signTypedData(typedDataFor(message))
}

const messageFor = (contentHash: `0x${string}`): ProofMessage => ({
  document: 'agreement.docx',
  contentHash,
  intent: 'approved',
  signedAt: 1_790_000_000n,
  signer: account.address,
})

describe('normalizeText', () => {
  it('collapses every flavour of whitespace to one space', () => {
    expect(normalizeText('a \t\n\r b')).toBe('a b')
    expect(normalizeText(`a${NBSP}b`)).toBe('a b')
    expect(normalizeText(`a${EM_SPACE}${THIN_SPACE}b`)).toBe('a b')
    expect(normalizeText('  padded  ')).toBe('padded')
  })

  it('drops zero-width characters, which are invisible and must not change a digest', () => {
    expect(normalizeText(`in${ZWSP}visible`)).toBe('invisible')
    expect(normalizeText(`${BOM}bom`)).toBe('bom')
  })

  it('normalises equivalent Unicode encodings to the same string', () => {
    // "é" as one code point vs e + combining acute
    expect(normalizeText(`caf${E_ACUTE}`)).toBe(normalizeText(`cafe${COMBINING_ACUTE}`))
  })

  it('keeps text that differs only in meaning', () => {
    expect(normalizeText('shall not')).not.toBe(normalizeText('shall'))
  })
})

describe('canonical serialisation', () => {
  it('is stable across calls', () => {
    expect(serializeCanonical(SAMPLE)).toBe(serializeCanonical(SAMPLE))
    expect(digestCanonical(SAMPLE)).toBe(digestCanonical(SAMPLE))
  })

  it('produces a 32-byte hex digest', () => {
    expect(digestCanonical(SAMPLE)).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('changes when any text changes', () => {
    const edited = doc([
      { k: 'h', lvl: 1, t: 'Carbon removal agreement' },
      { k: 'p', t: 'Ecoera agrees to deliver 100 tonnes.' },
      { k: 'li', lvl: 1, t: 'Delivery by 2027-01-01' },
      {
        k: 'tbl',
        rows: [
          ['Year', 'Tonnes'],
          ['2026', '400'],
        ],
      },
    ])
    expect(digestCanonical(edited)).not.toBe(digestCanonical(SAMPLE))
  })

  it('changes when structure changes but text does not', () => {
    const asParagraph = doc([
      { k: 'p', t: 'Carbon removal agreement' },
      { k: 'p', t: 'Ecoera agrees to deliver 1,000 tonnes.' },
      { k: 'li', lvl: 1, t: 'Delivery by 2027-01-01' },
      {
        k: 'tbl',
        rows: [
          ['Year', 'Tonnes'],
          ['2026', '400'],
        ],
      },
    ])
    expect(digestCanonical(asParagraph)).not.toBe(digestCanonical(SAMPLE))
  })

  it('changes when a heading level changes', () => {
    const demoted = doc([{ k: 'h', lvl: 2, t: 'Carbon removal agreement' }])
    const promoted = doc([{ k: 'h', lvl: 1, t: 'Carbon removal agreement' }])
    expect(digestCanonical(demoted)).not.toBe(digestCanonical(promoted))
  })

  it('changes when blocks are reordered', () => {
    const swapped = doc([
      { k: 'p', t: 'Ecoera agrees to deliver 1,000 tonnes.' },
      { k: 'h', lvl: 1, t: 'Carbon removal agreement' },
    ])
    const original = doc([
      { k: 'h', lvl: 1, t: 'Carbon removal agreement' },
      { k: 'p', t: 'Ecoera agrees to deliver 1,000 tonnes.' },
    ])
    expect(digestCanonical(swapped)).not.toBe(digestCanonical(original))
  })

  it('cannot be collided by moving a delimiter into the text', () => {
    // without length prefixes these two would serialise identically
    const a = doc([{ k: 'p', t: 'one|two' }])
    const b = doc([
      { k: 'p', t: 'one' },
      { k: 'p', t: 'two' },
    ])
    expect(digestCanonical(a)).not.toBe(digestCanonical(b))
  })

  it('cannot be collided by moving a table cell boundary', () => {
    const a = doc([{ k: 'tbl', rows: [['ab', 'c']] }])
    const b = doc([{ k: 'tbl', rows: [['a', 'bc']] }])
    expect(digestCanonical(a)).not.toBe(digestCanonical(b))
  })

  it('distinguishes an empty table row from a row with one empty cell', () => {
    const a = doc([{ k: 'tbl', rows: [[]] }])
    const b = doc([{ k: 'tbl', rows: [['']] }])
    expect(digestCanonical(a)).not.toBe(digestCanonical(b))
  })
})

describe('sign and verify, end to end', () => {
  it('verifies a genuine signature against the matching document', async () => {
    const hash = digestCanonical(SAMPLE)
    const message = messageFor(hash)
    const record = recordFrom(message, await sign(message))

    expect(record.signer).toBe(account.address)
    await expect(verifyProof(record, hash)).resolves.toMatchObject({ ok: true })
  })

  it('reports content-changed when the document was edited after signing', async () => {
    const message = messageFor(digestCanonical(SAMPLE))
    const record = recordFrom(message, await sign(message))

    const edited = digestCanonical(doc([{ k: 'p', t: 'something else entirely' }]))
    await expect(verifyProof(record, edited)).resolves.toMatchObject({
      ok: false,
      reason: 'content-changed',
    })
  })

  it('verifies the signature alone when the document is not at hand', async () => {
    const message = messageFor(digestCanonical(SAMPLE))
    const record = recordFrom(message, await sign(message))
    await expect(verifyProof(record, null)).resolves.toMatchObject({ ok: true })
  })

  it('rejects a signature lifted onto a different claimed signer', async () => {
    const message = messageFor(digestCanonical(SAMPLE))
    const signature = await sign(message)
    const impostor = '0x000000000000000000000000000000000000dEaD' as const
    const forged = { ...recordFrom(message, signature), signer: impostor }
    // signer is inside the signed struct, so swapping it changes what recovers
    await expect(verifyProof(forged, digestCanonical(SAMPLE))).resolves.toMatchObject({
      ok: false,
      reason: 'signer-mismatch',
    })
  })

  it('rejects a record whose hash was swapped after signing', async () => {
    const message = messageFor(digestCanonical(SAMPLE))
    const record = recordFrom(message, await sign(message))
    const other = digestCanonical(doc([{ k: 'p', t: 'other' }]))
    const tampered = { ...record, contentHash: other }
    // the hash is signed, so rewriting it breaks recovery before content is compared
    await expect(verifyProof(tampered, other)).resolves.toMatchObject({
      ok: false,
      reason: 'signer-mismatch',
    })
  })

  it('rejects a record whose intent was swapped after signing', async () => {
    const message = messageFor(digestCanonical(SAMPLE))
    const record = recordFrom(message, await sign(message))
    const tampered = { ...record, intent: 'authored' as const }
    await expect(verifyProof(tampered, digestCanonical(SAMPLE))).resolves.toMatchObject({
      ok: false,
      reason: 'signer-mismatch',
    })
  })

  it('rejects a garbage signature without throwing', async () => {
    const message = messageFor(digestCanonical(SAMPLE))
    const record = { ...recordFrom(message, await sign(message)), signature: '0xdeadbeef' as const }
    await expect(verifyProof(record, digestCanonical(SAMPLE))).resolves.toMatchObject({
      ok: false,
      reason: 'signature-invalid',
    })
  })
})

describe('asProofRecord', () => {
  it('accepts a well-formed record', async () => {
    const message = messageFor(digestCanonical(SAMPLE))
    const record = recordFrom(message, await sign(message))
    expect(asProofRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
  })

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
    ['a wrong-length hash', { contentHash: '0xabcd' }],
    ['an unknown intent', { intent: 'notarised' }],
    ['a future version', { version: 2 }],
  ])('rejects %s', (_label, patch) => {
    const base = {
      version: 1,
      document: 'a.docx',
      contentHash: `0x${'11'.repeat(32)}`,
      intent: 'approved',
      signedAt: '2026-10-03T00:00:00.000Z',
      signer: `0x${'22'.repeat(20)}`,
      signature: '0xabcdef',
      canonicalVersion: 1,
    }
    const value =
      patch && typeof patch === 'object' && !Array.isArray(patch) ? { ...base, ...patch } : patch
    expect(asProofRecord(value)).toBeNull()
  })

  it('rejects an unparseable date', () => {
    expect(
      asProofRecord({
        version: 1,
        document: 'a.docx',
        contentHash: `0x${'11'.repeat(32)}`,
        intent: 'approved',
        signedAt: 'not a date',
        signer: `0x${'22'.repeat(20)}`,
        signature: '0xab',
        canonicalVersion: 1,
      }),
    ).toBeNull()
  })
})

describe('typedDataJson', () => {
  it('is what the browser page hands to eth_signTypedData_v4', async () => {
    const message = messageFor(digestCanonical(SAMPLE))
    const parsed = JSON.parse(typedDataJson(message))
    expect(parsed.primaryType).toBe('DocumentProof')
    expect(parsed.domain).toEqual({ name: 'DuneOffice Document Proof', version: '1' })
    // the wallet needs EIP712Domain declared; bigint must survive as a string
    expect(parsed.types.EIP712Domain).toBeTruthy()
    expect(parsed.message.signedAt).toBe('1790000000')
  })

  it('produces a signature that verifies against the typed struct', async () => {
    // guards the JSON path against drifting from typedDataFor
    const message = messageFor(digestCanonical(SAMPLE))
    const parsed = JSON.parse(typedDataJson(message))
    const roundTripped: ProofMessage = {
      document: parsed.message.document,
      contentHash: parsed.message.contentHash,
      intent: parsed.message.intent,
      signedAt: BigInt(parsed.message.signedAt),
      signer: parsed.message.signer,
    }
    const record = recordFrom(roundTripped, await sign(roundTripped))
    await expect(verifyProof(record, digestCanonical(SAMPLE))).resolves.toMatchObject({ ok: true })
  })
})
