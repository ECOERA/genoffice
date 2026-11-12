/**
 * The attestation itself: an EIP-712 typed-data struct a wallet signs, and the
 * record that is stored beside (and inside) the document.
 *
 * EIP-712 rather than personal_sign because MetaMask renders typed data as a
 * labelled table — the signer sees the file name, the intent and the hash as
 * named fields instead of a wall of text, and cannot be tricked into blind
 * signing. The fields are deliberately few and all of them are meaningful to
 * a human reading the wallet prompt.
 *
 * The domain carries no chainId and no verifyingContract. A proof is an
 * off-chain statement about a file; binding it to a chain would mean a
 * verifier had to know which one, for no gain. Omitting them is explicitly
 * allowed by EIP-712 and makes the proof portable.
 */
import { recoverTypedDataAddress, type Address, type Hex } from 'viem'

/** what the signer is claiming about the document */
export const PROOF_INTENTS = ['authored', 'reviewed', 'approved', 'received'] as const
export type ProofIntent = (typeof PROOF_INTENTS)[number]

export function isProofIntent(value: unknown): value is ProofIntent {
  return typeof value === 'string' && (PROOF_INTENTS as readonly string[]).includes(value)
}

export const PROOF_DOMAIN = {
  name: 'DuneOffice Document Proof',
  version: '1',
} as const

export const PROOF_TYPES = {
  DocumentProof: [
    { name: 'document', type: 'string' },
    { name: 'contentHash', type: 'bytes32' },
    { name: 'intent', type: 'string' },
    { name: 'signedAt', type: 'uint64' },
    { name: 'signer', type: 'address' },
  ],
} as const

/**
 * The message a wallet signs.
 *
 * `signer` is inside the struct as well as being the recovering key: without
 * it a signature could be lifted onto a record claiming a different author,
 * and verification — which only checks that the recovered address matches the
 * claimed one — would still pass.
 *
 * `signedAt` is asserted by the signer, not proven. Nothing off-chain can stop
 * someone setting their own clock back; it is a statement, and the UI says so.
 */
export interface ProofMessage {
  /** file name at signing time, for the wallet prompt and for human context */
  readonly document: string
  readonly contentHash: Hex
  readonly intent: ProofIntent
  /** unix seconds */
  readonly signedAt: bigint
  readonly signer: Address
}

/** what gets written to the sidecar and embedded in the document */
export interface ProofRecord {
  /** record format version, independent of the canonical-form version */
  readonly version: 1
  readonly document: string
  readonly contentHash: Hex
  readonly intent: ProofIntent
  /** ISO 8601, derived from signedAt — the on-disk record is for humans too */
  readonly signedAt: string
  readonly signer: Address
  readonly signature: Hex
  /** which canonical-form rules produced contentHash */
  readonly canonicalVersion: 1
}

/** build the typed-data payload handed to eth_signTypedData_v4 */
export function typedDataFor(message: ProofMessage) {
  return {
    domain: PROOF_DOMAIN,
    types: PROOF_TYPES,
    primaryType: 'DocumentProof' as const,
    message,
  }
}

/**
 * The same payload as plain JSON, for the browser page: eth_signTypedData_v4
 * takes a JSON string, and a bigint cannot be serialised.
 */
export function typedDataJson(message: ProofMessage): string {
  return JSON.stringify({
    domain: PROOF_DOMAIN,
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
      ],
      ...PROOF_TYPES,
    },
    primaryType: 'DocumentProof',
    message: { ...message, signedAt: message.signedAt.toString() },
  })
}

export function recordFrom(message: ProofMessage, signature: Hex): ProofRecord {
  return {
    version: 1,
    document: message.document,
    contentHash: message.contentHash,
    intent: message.intent,
    signedAt: new Date(Number(message.signedAt) * 1000).toISOString(),
    signer: message.signer,
    signature,
    canonicalVersion: 1,
  }
}

export function messageFrom(record: ProofRecord): ProofMessage {
  return {
    document: record.document,
    contentHash: record.contentHash,
    intent: record.intent,
    signedAt: BigInt(Math.floor(new Date(record.signedAt).getTime() / 1000)),
    signer: record.signer,
  }
}

/** why a proof failed to verify; the UI turns these into one sentence each */
export type ProofFailure = 'malformed' | 'signature-invalid' | 'signer-mismatch' | 'content-changed'

export type ProofResult =
  | { readonly ok: true; readonly record: ProofRecord }
  | { readonly ok: false; readonly reason: ProofFailure; readonly record?: ProofRecord }

/** structural check before any crypto: a malformed record must not reach viem */
export function asProofRecord(value: unknown): ProofRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null)
  const hex = (v: unknown, bytes?: number) =>
    typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) && (!bytes || v.length === 2 + bytes * 2)
      ? (v as Hex)
      : null
  const document = str(raw.document)
  const contentHash = hex(raw.contentHash, 32)
  const signature = hex(raw.signature)
  const signer = hex(raw.signer, 20)
  const signedAt = str(raw.signedAt)
  if (!document || !contentHash || !signature || !signer || !signedAt) return null
  if (!isProofIntent(raw.intent)) return null
  if (Number.isNaN(new Date(signedAt).getTime())) return null
  if (raw.version !== 1 || raw.canonicalVersion !== 1) return null
  return {
    version: 1,
    document,
    contentHash,
    intent: raw.intent,
    signedAt,
    signer: signer as Address,
    signature,
    canonicalVersion: 1,
  }
}

/**
 * Verify a proof against the document it claims to describe.
 *
 * Offline and complete: recovering the address from an EIP-712 signature needs
 * no node, no network and no chain. `actualContentHash` is recomputed from the
 * document on disk by the caller; passing null checks only that the signature
 * is internally valid, which is what you want when showing who signed a record
 * whose document is not at hand.
 */
export async function verifyProof(
  record: ProofRecord,
  actualContentHash: Hex | null,
): Promise<ProofResult> {
  let recovered: Address
  try {
    recovered = await recoverTypedDataAddress({
      ...typedDataFor(messageFrom(record)),
      signature: record.signature,
    })
  } catch {
    return { ok: false, reason: 'signature-invalid', record }
  }
  if (recovered.toLowerCase() !== record.signer.toLowerCase()) {
    return { ok: false, reason: 'signer-mismatch', record }
  }
  // content last: a changed document with a sound signature is the interesting
  // case, and the caller wants to know the signature itself was genuine
  if (
    actualContentHash !== null &&
    actualContentHash.toLowerCase() !== record.contentHash.toLowerCase()
  ) {
    return { ok: false, reason: 'content-changed', record }
  }
  return { ok: true, record }
}
