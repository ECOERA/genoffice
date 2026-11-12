import { describe, expect, it } from 'vitest'
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  keccak256,
  parseAbiParameters,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  anchorMatches,
  asAnchorRecord,
  attestCalldata,
  attestationUrl,
  BASE,
  BASE_SEPOLIA,
  decodeProofData,
  EAS_ABI,
  easChain,
  encodeProofData,
  PROOF_SCHEMA,
  proofSchemaUid,
  recordFrom,
  registerSchemaCalldata,
  typedDataFor,
  SCHEMA_REGISTRY_ABI,
  SCHEMA_RESOLVER,
  SCHEMA_REVOCABLE,
  type ProofMessage,
  type ProofRecord,
} from '../src/index'

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const account = privateKeyToAccount(KEY)

const CONTENT_HASH = `0x${'ab'.repeat(32)}` as const

const message: ProofMessage = {
  document: 'agreement.docx',
  contentHash: CONTENT_HASH,
  intent: 'approved',
  signedAt: 1_790_000_000n,
  signer: account.address,
}

async function makeRecord(): Promise<ProofRecord> {
  return recordFrom(message, await account.signTypedData(typedDataFor(message)))
}

const DATA_ABI = parseAbiParameters(
  'bytes32 contentHash, string document, string intent, uint64 signedAt, bytes signature',
)

/** encode an attestation body with an arbitrary intent string */
function encodeWithIntent(intent: string) {
  return encodeAbiParameters(DATA_ABI, [CONTENT_HASH, 'a.docx', intent, 1n, '0xab'])
}

describe('chain configuration', () => {
  it('uses the OP-stack predeploys, which are the same on Base and Base Sepolia', () => {
    // verified against ethereum-attestation-service/eas-docs-site
    expect(BASE.eas).toBe('0x4200000000000000000000000000000000000021')
    expect(BASE.schemaRegistry).toBe('0x4200000000000000000000000000000000000020')
    expect(BASE_SEPOLIA.eas).toBe(BASE.eas)
    expect(BASE_SEPOLIA.schemaRegistry).toBe(BASE.schemaRegistry)
  })

  it('knows its chain ids', () => {
    expect(BASE.chainId).toBe(8453)
    expect(BASE_SEPOLIA.chainId).toBe(84532)
    expect(easChain(8453)).toBe(BASE)
    expect(easChain(1)).toBeNull()
  })

  it('builds an attestation URL a recipient can open', () => {
    const uid = `0x${'11'.repeat(32)}` as const
    expect(attestationUrl(BASE, uid)).toBe(`https://base.easscan.org/attestation/view/${uid}`)
  })
})

describe('schema UID', () => {
  it('matches SchemaRegistry._getUID', () => {
    // keccak256(abi.encodePacked(schema, resolver, revocable)) — the contract's
    // own derivation, so the UID is knowable before anyone has registered it
    const expected = keccak256(
      encodePacked(['string', 'address', 'bool'], [PROOF_SCHEMA, zeroAddress, true]),
    )
    expect(proofSchemaUid()).toBe(expected)
  })

  it('is stable: changing the schema would orphan every attestation', () => {
    // a canary on the schema text itself — if this fails, the field list moved
    expect(PROOF_SCHEMA).toBe(
      'bytes32 contentHash,string document,string intent,uint64 signedAt,bytes signature',
    )
    expect(SCHEMA_RESOLVER).toBe(zeroAddress)
    expect(SCHEMA_REVOCABLE).toBe(true)
  })
})

describe('attestation data', () => {
  it('round-trips a record', async () => {
    const record = await makeRecord()
    const decoded = decodeProofData(encodeProofData(record))
    expect(decoded).not.toBeNull()
    expect(decoded!.contentHash).toBe(record.contentHash)
    expect(decoded!.document).toBe(record.document)
    expect(decoded!.intent).toBe(record.intent)
    expect(decoded!.signature).toBe(record.signature)
    expect(decoded!.signedAt).toBe(1_790_000_000n)
  })

  it('carries the signature, so the on-chain copy stands alone', async () => {
    const record = await makeRecord()
    const [, , , , signature] = decodeAbiParameters(DATA_ABI, encodeProofData(record))
    // anyone reading the chain can recover the signer from this alone
    expect(signature).toBe(record.signature)
  })

  it('rejects data that is not one of ours', () => {
    expect(decodeProofData('0xdeadbeef')).toBeNull()
  })

  it('rejects an attestation with an unknown intent', () => {
    expect(decodeProofData(encodeWithIntent('notarised'))).toBeNull()
  })
})

describe('calldata', () => {
  it('builds an attest() call under our schema, addressed to the signer', async () => {
    const record = await makeRecord()
    const { functionName, args } = decodeFunctionData({
      abi: EAS_ABI,
      data: attestCalldata(record),
    })
    expect(functionName).toBe('attest')
    const request = (args as readonly unknown[])[0] as {
      schema: string
      data: { recipient: string; expirationTime: bigint; revocable: boolean; value: bigint }
    }
    expect(request.schema).toBe(proofSchemaUid())
    expect(request.data.recipient.toLowerCase()).toBe(record.signer.toLowerCase())
    // a statement about a document does not expire, and sends no ether
    expect(request.data.expirationTime).toBe(0n)
    expect(request.data.value).toBe(0n)
    expect(request.data.revocable).toBe(true)
  })

  it('builds a register() call for the exact schema the UID is derived from', () => {
    const { functionName, args } = decodeFunctionData({
      abi: SCHEMA_REGISTRY_ABI,
      data: registerSchemaCalldata(),
    })
    expect(functionName).toBe('register')
    expect(args).toEqual([PROOF_SCHEMA, SCHEMA_RESOLVER, SCHEMA_REVOCABLE])
  })
})

describe('anchorMatches', () => {
  it('accepts an attestation of this very proof', async () => {
    const record = await makeRecord()
    expect(anchorMatches(record, decodeProofData(encodeProofData(record))!)).toBe(true)
  })

  it.each([
    ['a different document name', { document: 'other.docx' }],
    ['a different intent', { intent: 'authored' as const }],
    ['a different content hash', { contentHash: `0x${'cd'.repeat(32)}` as const }],
    ['a different signature', { signature: '0xdead' as const }],
  ])('rejects an attestation with %s', async (_label, patch) => {
    const record = await makeRecord()
    const published = decodeProofData(encodeProofData({ ...record, ...patch }))!
    expect(anchorMatches(record, published)).toBe(false)
  })

  it('rejects an attestation whose signing time was altered', async () => {
    const record = await makeRecord()
    const shifted = { ...record, signedAt: new Date(Date.now()).toISOString() }
    expect(anchorMatches(record, decodeProofData(encodeProofData(shifted))!)).toBe(false)
  })
})

describe('asAnchorRecord', () => {
  const valid = {
    chainId: 8453,
    uid: `0x${'11'.repeat(32)}`,
    txHash: `0x${'22'.repeat(32)}`,
    attester: `0x${'33'.repeat(20)}`,
    anchoredAt: '2026-10-03T12:00:00.000Z',
  }

  it('accepts a well-formed anchor', () => {
    expect(asAnchorRecord(valid)).toEqual(valid)
  })

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an unknown chain', { chainId: 1 }],
    ['a short uid', { uid: '0xabcd' }],
    ['a short tx hash', { txHash: '0xabcd' }],
    ['a bad address', { attester: '0xzz' }],
    ['an unparseable date', { anchoredAt: 'whenever' }],
  ])('rejects %s', (_label, patch) => {
    const value =
      patch && typeof patch === 'object' && !Array.isArray(patch) ? { ...valid, ...patch } : patch
    expect(asAnchorRecord(value)).toBeNull()
  })
})
