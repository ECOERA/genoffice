/**
 * Signing and verifying a document, end to end.
 *
 * The flow, and why it is in this order:
 *   1. read the document and reduce it to its canonical form, so the hash
 *      describes the content rather than the bytes (see doc-proof/canonical);
 *   2. ask the wallet to sign, in the user's browser where MetaMask lives;
 *   3. verify the returned signature ourselves before storing anything — the
 *      page is ordinary web content and its claim about which address signed
 *      is not evidence, recovery is;
 *   4. only then write the sidecar and embed the proof in the file.
 *
 * Step 3 is the one that matters: a proof that was never checked at write time
 * would sit in a document looking authoritative until someone tried to verify
 * it, which may be years later and somewhere else.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { parseDocx } from '@genoffice/docx-engine'
import {
  attestationUrl,
  BASE,
  digestCanonical,
  easChain,
  recordFrom,
  verifyProof,
  type AnchorRecord,
  type EasChain,
  type ProofIntent,
  type ProofRecord,
  type ProofResult,
} from '@genoffice/doc-proof'
import { canonicalFromBlocks } from '@genoffice/doc-proof/docx'
import { requestWalletSignature, ProofSignError } from './proof-sign'
import { anchorProof, ProofAnchorError } from './proof-anchor'
import { embedProof, loadProof, writeSidecar, type StoredProof } from './proof-store'

/** formats whose content we can reduce to a canonical form today */
export function canProve(path: string): boolean {
  return /\.docx$/i.test(path)
}

/** the content digest for a document on disk */
export async function contentHashOf(path: string): Promise<`0x${string}`> {
  if (!canProve(path)) throw new ProofSignError('Only .docx documents can be signed yet.')
  const parsed = await parseDocx(await readFile(path))
  return digestCanonical(canonicalFromBlocks(parsed.blocks))
}

export interface SignDocumentOptions {
  readonly openExternal: (url: string) => Promise<void>
  readonly signal?: AbortSignal
}

/**
 * Sign a document and store the proof. Returns the stored record.
 *
 * The file is re-read after signing rather than reusing the bytes from step 1:
 * the document may have been saved while the user was in the browser, and
 * embedding into stale bytes would silently roll that save back.
 */
export async function signDocument(
  path: string,
  documentName: string,
  intent: ProofIntent,
  opts: SignDocumentOptions,
): Promise<ProofRecord> {
  const contentHash = await contentHashOf(path)
  const unsigned = {
    document: documentName,
    contentHash,
    intent,
    signedAt: BigInt(Math.floor(Date.now() / 1000)),
  }

  const { address, signature } = await requestWalletSignature(unsigned, {
    openExternal: opts.openExternal,
    documentName,
    signal: opts.signal,
  })

  const record = recordFrom({ ...unsigned, signer: address }, signature)

  // never store a proof we have not checked ourselves
  const checked = await verifyProof(record, contentHash)
  if (!checked.ok) {
    throw new ProofSignError(
      checked.reason === 'content-changed'
        ? 'The document changed while you were signing. Try again.'
        : 'The wallet returned a signature that does not verify.',
    )
  }

  // a fresh signature is never anchored: publishing is a separate, paid act
  await store(path, { record, anchor: null }, contentHash)
  return record
}

/**
 * Write a proof to both places.
 *
 * The file is re-read rather than reusing bytes from earlier: the document may
 * have been saved while the user was in the browser, and embedding into stale
 * bytes would silently roll that save back. If the document did move on, the
 * sidecar still records a valid proof of the version that was signed, and
 * embedding is skipped because it would misrepresent the file.
 */
async function store(path: string, stored: StoredProof, signedHash: string): Promise<void> {
  await writeSidecar(path, stored)
  if (!canProve(path)) return
  const current = await readFile(path)
  const latestHash = digestCanonical(canonicalFromBlocks((await parseDocx(current)).blocks))
  if (latestHash === signedHash) {
    await writeFile(path, await embedProof(current, stored))
  }
}

export interface AnchorDocumentOptions {
  readonly openExternal: (url: string) => Promise<void>
  readonly chainId?: number
  readonly signal?: AbortSignal
}

/**
 * Publish an existing proof on-chain and record where it landed.
 *
 * Refuses anything that does not currently verify: anchoring a proof whose
 * document has moved on would publish a permanent claim about a version the
 * file no longer holds.
 */
export async function anchorDocument(
  path: string,
  opts: AnchorDocumentOptions,
): Promise<AnchorRecord> {
  const bytes = await readFile(path)
  const stored = await loadProof(path, canProve(path) ? bytes : null)
  if (!stored) throw new ProofAnchorError('This document has no proof to publish yet.')
  if (stored.anchor) throw new ProofAnchorError('This proof is already published.')

  const contentHash = await contentHashOf(path)
  const checked = await verifyProof(stored.record, contentHash)
  if (!checked.ok) {
    throw new ProofAnchorError(
      checked.reason === 'content-changed'
        ? 'The document changed after it was signed. Sign it again before publishing.'
        : 'This proof does not verify, so it cannot be published.',
    )
  }

  const chain: EasChain = (opts.chainId ? easChain(opts.chainId) : BASE) ?? BASE
  const anchor = await anchorProof(stored.record, {
    openExternal: opts.openExternal,
    documentName: stored.record.document,
    chain,
    signal: opts.signal,
  })

  await store(path, { record: stored.record, anchor }, contentHash)
  return anchor
}

export interface ProofStatus {
  readonly state: 'unsigned' | 'valid' | 'content-changed' | 'invalid'
  readonly record?: ProofRecord
  /** present once the proof has been published on-chain */
  readonly anchor?: AnchorRecord
  /** the public page for the anchor, for a recipient without DuneOffice */
  readonly anchorUrl?: string
}

/** what the UI shows for a document: who signed it, and whether it still holds */
export async function proofStatusOf(path: string): Promise<ProofStatus> {
  let bytes: Uint8Array
  try {
    bytes = await readFile(path)
  } catch {
    return { state: 'unsigned' }
  }

  const stored = await loadProof(path, canProve(path) ? bytes : null)
  if (!stored) return { state: 'unsigned' }
  const { record, anchor } = stored

  let actual: `0x${string}` | null = null
  if (canProve(path)) {
    try {
      actual = digestCanonical(canonicalFromBlocks((await parseDocx(bytes)).blocks))
    } catch {
      // unreadable document: the signature can still be checked on its own
      actual = null
    }
  }

  const chain = anchor ? easChain(anchor.chainId) : null
  const anchored = anchor
    ? { anchor, anchorUrl: chain ? attestationUrl(chain, anchor.uid) : undefined }
    : {}

  const result: ProofResult = await verifyProof(record, actual)
  if (result.ok) return { state: 'valid', record, ...anchored }
  return {
    state: result.reason === 'content-changed' ? 'content-changed' : 'invalid',
    record: result.record,
    ...anchored,
  }
}
