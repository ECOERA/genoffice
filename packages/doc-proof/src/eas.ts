/**
 * Anchoring a proof on-chain, via the Ethereum Attestation Service.
 *
 * Signing a document costs nothing and proves two things offline: who signed,
 * and whether the content changed. The one thing it cannot prove is *when* —
 * `signedAt` is asserted by the signer, and nothing off-chain stops someone
 * setting their clock back. Publishing the proof as an attestation fixes
 * exactly that: the block's timestamp is not the signer's to choose.
 *
 * EAS rather than a contract of our own: it is already deployed on Base, so
 * there is nothing for us to write, deploy, audit or keep alive, and an
 * attestation gets a public page a recipient can open without DuneOffice.
 *
 * The attestation carries the signature itself, not just the hash. That makes
 * the on-chain record independently checkable: anyone can recover the signer
 * from it, so even an attestation paid for by somebody else still proves who
 * signed. The attester and the signer are therefore allowed to differ, and the
 * UI shows both when they do.
 *
 * Anchoring is deliberately optional and per-document. Signing is free and
 * private; anchoring costs gas and publishes the content hash and the signer's
 * address to a permanent public ledger. That is a choice to make per document,
 * not a default — see docs/document-proofs.md.
 */
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem'
import type { ProofIntent, ProofRecord } from './proof'
import { isProofIntent } from './proof'

export interface EasChain {
  readonly chainId: number
  /** what the UI calls it */
  readonly name: string
  /** EAS.sol */
  readonly eas: Address
  /** SchemaRegistry.sol */
  readonly schemaRegistry: Address
  /** public RPC, used to read back what was written */
  readonly rpcUrl: string
  /** EAS's own attestation viewer — the link handed to a recipient */
  readonly easscan: string
  /** EAS's index for that chain; a hint only, the chain is the authority */
  readonly graphql: string
  readonly currencySymbol: string
}

/**
 * Both are OP-stack predeploys, so mainnet and testnet share the addresses;
 * they are verified against ethereum-attestation-service/eas-docs-site.
 */
const EAS_PREDEPLOY = '0x4200000000000000000000000000000000000021' as const
const SCHEMA_REGISTRY_PREDEPLOY = '0x4200000000000000000000000000000000000020' as const

export const BASE: EasChain = {
  chainId: 8453,
  name: 'Base',
  eas: EAS_PREDEPLOY,
  schemaRegistry: SCHEMA_REGISTRY_PREDEPLOY,
  rpcUrl: 'https://mainnet.base.org',
  easscan: 'https://base.easscan.org',
  graphql: 'https://base.easscan.org/graphql',
  currencySymbol: 'ETH',
}

export const BASE_SEPOLIA: EasChain = {
  chainId: 84532,
  name: 'Base Sepolia',
  eas: EAS_PREDEPLOY,
  schemaRegistry: SCHEMA_REGISTRY_PREDEPLOY,
  rpcUrl: 'https://sepolia.base.org',
  easscan: 'https://base-sepolia.easscan.org',
  graphql: 'https://base-sepolia.easscan.org/graphql',
  currencySymbol: 'ETH',
}

export const EAS_CHAINS: readonly EasChain[] = [BASE, BASE_SEPOLIA]

export function easChain(chainId: number): EasChain | null {
  return EAS_CHAINS.find((c) => c.chainId === chainId) ?? null
}

/**
 * The schema. Field order is fixed forever: changing it changes the schema
 * UID, which would orphan every attestation made under the old one.
 */
export const PROOF_SCHEMA =
  'bytes32 contentHash,string document,string intent,uint64 signedAt,bytes signature'

/** no resolver contract: nothing to run when an attestation is made */
export const SCHEMA_RESOLVER = zeroAddress
/** revocable so a signer can publicly withdraw a claim they regret */
export const SCHEMA_REVOCABLE = true

const SCHEMA_DATA_ABI = parseAbiParameters(
  'bytes32 contentHash, string document, string intent, uint64 signedAt, bytes signature',
)

export const EAS_ABI = parseAbi([
  'struct AttestationRequestData { address recipient; uint64 expirationTime; bool revocable; bytes32 refUID; bytes data; uint256 value; }',
  'struct AttestationRequest { bytes32 schema; AttestationRequestData data; }',
  'struct Attestation { bytes32 uid; bytes32 schema; uint64 time; uint64 expirationTime; uint64 revocationTime; bytes32 refUID; address recipient; address attester; bool revocable; bytes data; }',
  'function attest(AttestationRequest request) external payable returns (bytes32)',
  'function getAttestation(bytes32 uid) external view returns (Attestation)',
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
])

export const SCHEMA_REGISTRY_ABI = parseAbi([
  'struct SchemaRecord { bytes32 uid; address resolver; bool revocable; string schema; }',
  'function register(string schema, address resolver, bool revocable) external returns (bytes32)',
  'function getSchema(bytes32 uid) external view returns (SchemaRecord)',
])

/**
 * The schema's UID, computed rather than configured.
 *
 * SchemaRegistry derives it as keccak256(abi.encodePacked(schema, resolver,
 * revocable)), so it is the same on every chain and can be known before the
 * schema has been registered anywhere. That means no hardcoded UID to get
 * wrong, and the app can tell "not registered on this chain yet" from "wrong
 * schema" by simply asking the registry.
 */
export function proofSchemaUid(): Hex {
  return keccak256(
    encodePacked(['string', 'address', 'bool'], [PROOF_SCHEMA, SCHEMA_RESOLVER, SCHEMA_REVOCABLE]),
  )
}

/** the attestation body: the proof, field for field */
export function encodeProofData(record: ProofRecord): Hex {
  return encodeAbiParameters(SCHEMA_DATA_ABI, [
    record.contentHash,
    record.document,
    record.intent,
    BigInt(Math.floor(new Date(record.signedAt).getTime() / 1000)),
    record.signature,
  ])
}

export interface DecodedProofAttestation {
  readonly contentHash: Hex
  readonly document: string
  readonly intent: ProofIntent
  readonly signedAt: bigint
  readonly signature: Hex
}

/** read an attestation body back; null if it is not one of ours */
export function decodeProofData(data: Hex): DecodedProofAttestation | null {
  try {
    const [contentHash, document, intent, signedAt, signature] = decodeAbiParameters(
      SCHEMA_DATA_ABI,
      data,
    )
    if (!isProofIntent(intent)) return null
    return { contentHash, document, intent, signedAt, signature }
  } catch {
    return null
  }
}

/** calldata for registering the schema; needed once per chain, by whoever is first */
export function registerSchemaCalldata(): Hex {
  return encodeFunctionData({
    abi: SCHEMA_REGISTRY_ABI,
    functionName: 'register',
    args: [PROOF_SCHEMA, SCHEMA_RESOLVER, SCHEMA_REVOCABLE],
  })
}

/**
 * Calldata for the attestation.
 *
 * The recipient is the signer: EAS calls the subject of an attestation its
 * recipient, and the subject here is the person who made the claim. It also
 * makes the attestation show up when anyone looks that address up on easscan.
 */
export function attestCalldata(record: ProofRecord): Hex {
  return encodeFunctionData({
    abi: EAS_ABI,
    functionName: 'attest',
    args: [
      {
        schema: proofSchemaUid(),
        data: {
          recipient: record.signer,
          expirationTime: 0n, // a statement about a document does not expire
          revocable: SCHEMA_REVOCABLE,
          refUID: zeroHash,
          data: encodeProofData(record),
          value: 0n,
        },
      },
    ],
  })
}

/** what the sidecar records once a proof has been published */
export interface AnchorRecord {
  readonly chainId: number
  /** the attestation's UID — the thing easscan looks up */
  readonly uid: Hex
  readonly txHash: Hex
  /** who paid for and sent the attestation; not necessarily the signer */
  readonly attester: Address
  /** ISO 8601, from the block — this is the timestamp nobody chose */
  readonly anchoredAt: string
}

/** the public page for an attestation, for a recipient without DuneOffice */
export function attestationUrl(chain: EasChain, uid: Hex): string {
  return `${chain.easscan}/attestation/view/${uid}`
}

/**
 * Does what is on-chain actually describe this proof?
 *
 * Checked before an anchor is stored, for the same reason the signature is
 * verified before a proof is: a transaction hash reported by a web page is a
 * claim, and the chain is the only thing that settles it.
 */
export function anchorMatches(record: ProofRecord, decoded: DecodedProofAttestation): boolean {
  return (
    decoded.contentHash.toLowerCase() === record.contentHash.toLowerCase() &&
    decoded.signature.toLowerCase() === record.signature.toLowerCase() &&
    decoded.document === record.document &&
    decoded.intent === record.intent &&
    decoded.signedAt === BigInt(Math.floor(new Date(record.signedAt).getTime() / 1000))
  )
}

/** structural check for an anchor read off disk */
export function asAnchorRecord(value: unknown): AnchorRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const hex = (v: unknown, bytes?: number) =>
    typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) && (!bytes || v.length === 2 + bytes * 2)
      ? (v as Hex)
      : null
  const uid = hex(raw.uid, 32)
  const txHash = hex(raw.txHash, 32)
  const attester = hex(raw.attester, 20)
  const anchoredAt = typeof raw.anchoredAt === 'string' ? raw.anchoredAt : null
  if (!uid || !txHash || !attester || !anchoredAt) return null
  if (typeof raw.chainId !== 'number' || !easChain(raw.chainId)) return null
  if (Number.isNaN(new Date(anchoredAt).getTime())) return null
  return { chainId: raw.chainId, uid, txHash, attester: attester as Address, anchoredAt }
}
