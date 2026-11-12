/**
 * Where a proof lives on disk.
 *
 * Two places, on purpose:
 *   - a `<document>.sig.json` sidecar, which works for every format from day
 *     one and is readable by anything that can read JSON;
 *   - inside the .docx itself, as a custom XML part, so the document can be
 *     sent as a single file and still carry its proof.
 *
 * The embedded copy is authoritative when both exist and disagree, because it
 * travelled with the file. A sidecar is easy to lose and easy to swap.
 *
 * The custom part is invisible to Word: it lives under customXml/, is declared
 * in [Content_Types].xml and related from the document part, and Word neither
 * renders nor strips it. Our own saveDocx copies unrecognised parts verbatim,
 * so the proof survives a round-trip through the editor.
 *
 * An on-chain anchor is stored beside the record, never inside it: the record
 * is exactly what was signed, and the anchor happens afterwards. On disk the
 * JSON is flat — the record's own fields plus an `anchor` object — so a file
 * written before anchoring existed still reads, and an unanchored proof is
 * byte-identical to what the previous version wrote.
 */
import { readFile, writeFile } from 'node:fs/promises'
import {
  asAnchorRecord,
  asProofRecord,
  type AnchorRecord,
  type ProofRecord,
} from '@genoffice/doc-proof'
import JSZip from 'jszip'

/** a proof as it is stored: what was signed, plus where it was published */
export interface StoredProof {
  readonly record: ProofRecord
  readonly anchor: AnchorRecord | null
}

/** the flat on-disk JSON for a stored proof */
function storedJson(stored: StoredProof): Record<string, unknown> {
  return stored.anchor ? { ...stored.record, anchor: stored.anchor } : { ...stored.record }
}

function parseStored(value: unknown): StoredProof | null {
  const record = asProofRecord(value)
  if (!record) return null
  const raw = value as Record<string, unknown>
  return { record, anchor: asAnchorRecord(raw.anchor) }
}

/** sidecar path for a document: /a/b/report.docx -> /a/b/report.docx.sig.json */
export function sidecarPathFor(documentPath: string): string {
  return `${documentPath}.sig.json`
}

export async function readSidecar(documentPath: string): Promise<StoredProof | null> {
  try {
    const raw = await readFile(sidecarPathFor(documentPath), 'utf8')
    return parseStored(JSON.parse(raw) as unknown)
  } catch {
    // missing, unreadable or not JSON: simply unproven
    return null
  }
}

export async function writeSidecar(documentPath: string, stored: StoredProof): Promise<void> {
  await writeFile(
    sidecarPathFor(documentPath),
    `${JSON.stringify(storedJson(stored), null, 2)}\n`,
    'utf8',
  )
}

/** the part path inside the .docx package */
const PART_PATH = 'customXml/duneofficeProof.xml'
const PART_RELS = 'customXml/_rels/duneofficeProof.xml.rels'
const PROOF_NS = 'https://duneoffice.app/schemas/document-proof/1'

function proofXml(stored: StoredProof): string {
  // the record is JSON inside a CDATA section: one parser for both storage
  // locations, so the two can never drift apart in how they are read
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<documentProof xmlns="${PROOF_NS}" version="1"><![CDATA[${JSON.stringify(storedJson(stored))}]]></documentProof>`
}

function readProofXml(xml: string): StoredProof | null {
  const match = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(xml)
  if (!match) return null
  try {
    return parseStored(JSON.parse(match[1]!) as unknown)
  } catch {
    return null
  }
}

/** read the embedded proof from .docx bytes; null when there is none */
export async function readEmbeddedProof(bytes: Uint8Array): Promise<StoredProof | null> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    const part = zip.file(PART_PATH)
    if (!part) return null
    return readProofXml(await part.async('string'))
  } catch {
    return null
  }
}

/**
 * Write the proof into .docx bytes, returning the new package.
 *
 * Replaces any previous proof rather than accumulating them: a document has
 * one current proof, and keeping stale ones would mean having to explain which
 * of several signatures applies.
 */
export async function embedProof(bytes: Uint8Array, stored: StoredProof): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)

  zip.file(PART_PATH, proofXml(stored))
  zip.file(
    PART_RELS,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
  )

  // [Content_Types].xml must declare the part or Word reports the file corrupt
  const typesFile = zip.file('[Content_Types].xml')
  if (!typesFile) throw new Error('not a docx: missing [Content_Types].xml')
  let types = await typesFile.async('string')
  if (!types.includes(`PartName="/${PART_PATH}"`)) {
    const override = `<Override PartName="/${PART_PATH}" ContentType="application/xml"/>`
    types = types.replace('</Types>', `${override}</Types>`)
    zip.file('[Content_Types].xml', types)
  }

  // relate the part from the document so the package is well-formed
  const relsPath = 'word/_rels/document.xml.rels'
  const relsFile = zip.file(relsPath)
  if (relsFile) {
    let rels = await relsFile.async('string')
    if (!rels.includes(PART_PATH)) {
      const id = `rIdDuneProof`
      const rel =
        `<Relationship Id="${id}" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" ` +
        `Target="../${PART_PATH}"/>`
      rels = rels.replace('</Relationships>', `${rel}</Relationships>`)
      zip.file(relsPath, rels)
    }
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

/**
 * The proof for a document, preferring the embedded copy.
 *
 * `bytes` is the document as it currently sits on disk; pass null for formats
 * that have no embedding yet, and the sidecar answers alone.
 */
export async function loadProof(
  documentPath: string,
  bytes: Uint8Array | null,
): Promise<StoredProof | null> {
  const embedded = bytes ? await readEmbeddedProof(bytes) : null
  return embedded ?? (await readSidecar(documentPath))
}
