/**
 * Canonical content digest.
 *
 * A proof has to survive a round-trip through the editor. Saving a .docx
 * re-serialises the XML and rebuilds the zip, so the file's bytes change even
 * when nobody touched a word — hashing the bytes would invalidate every
 * signature on the first save. Instead the document is reduced to a canonical
 * form that captures what the document *says* and how it is *organised*, and
 * that form is hashed.
 *
 * What is covered, and therefore what breaks a signature when it changes:
 *   - the text of every paragraph, heading, list item and table cell
 *   - the document's block structure and ordering, heading and list levels
 *   - whether a run is struck through (deleted text changes the meaning)
 *   - the content of embedded images, by their own hash
 *
 * What is deliberately NOT covered, so that re-saving and re-styling keep a
 * signature valid:
 *   - purely visual formatting: font, size, colour, bold, italic, underline
 *   - zip order, XML attribute order, part names, revision ids, timestamps
 *   - comments and tracked-change metadata (they are commentary, not content)
 *
 * The line is "could this change what a reader understands the document to
 * claim?". Strikethrough can; a colour cannot. A signer is attesting to the
 * words, not to the typography — see docs/document-proofs.md.
 */
import { createHash } from 'node:crypto'

/** one entry in the canonical form; the key names are short because they are hashed */
export type CanonicalBlock =
  | { readonly k: 'p'; readonly t: string }
  | { readonly k: 'h'; readonly lvl: number; readonly t: string }
  | { readonly k: 'li'; readonly lvl: number; readonly t: string }
  | { readonly k: 'tbl'; readonly rows: readonly (readonly string[])[] }
  | { readonly k: 'img'; readonly sha: string }

export interface CanonicalDoc {
  /** canonical form version; bump only for a breaking change to these rules */
  readonly v: 1
  readonly blocks: readonly CanonicalBlock[]
}

/** marks text a run struck through, so deleting-by-strikethrough changes the digest */
export const STRIKE_OPEN = '⦘'
export const STRIKE_CLOSE = '⦙'

/**
 * Patterns built from escaped strings rather than regex literals: Prettier
 * rewrites \uXXXX inside a literal to the character itself, which leaves
 * invisible code points in the source and trips no-irregular-whitespace. In a
 * quoted string the escape survives, so what is matched stays legible.
 */
const ZERO_WIDTH = new RegExp('[\\u200B-\\u200D\\uFEFF]', 'g')
const ANY_SPACE = new RegExp('[\\s\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]+', 'g')

/**
 * Normalise a text fragment.
 *
 * NFC first: the same accented character has several encodings, and which one
 * a document carries depends on the keyboard and the editor that produced it.
 * Then every run of whitespace — including NBSP, the various Unicode spaces
 * and any line-ending convention — collapses to one plain space, because the
 * engine is free to re-split a line across runs without changing the text a
 * reader sees. Zero-width characters are dropped entirely: they are invisible,
 * so they must not be able to change a digest.
 */
export function normalizeText(raw: string): string {
  return raw.normalize('NFC').replace(ZERO_WIDTH, '').replace(ANY_SPACE, ' ').trim()
}

/** SHA-256 of arbitrary bytes, lowercase hex — used for embedded images */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Serialise the canonical form deterministically.
 *
 * Hand-rolled rather than JSON.stringify so the byte sequence is pinned by
 * this function and cannot drift if the object shape grows a field: every
 * value is written in a fixed order with an explicit length prefix, so no
 * combination of texts can be made to collide by moving a delimiter into the
 * content.
 */
export function serializeCanonical(doc: CanonicalDoc): string {
  const part = (s: string) => `${s.length}:${s}`
  const out: string[] = [`v${doc.v}`]
  for (const block of doc.blocks) {
    switch (block.k) {
      case 'p':
        out.push(`p|${part(block.t)}`)
        break
      case 'h':
        out.push(`h|${block.lvl}|${part(block.t)}`)
        break
      case 'li':
        out.push(`li|${block.lvl}|${part(block.t)}`)
        break
      case 'tbl':
        out.push(
          `tbl|${block.rows.length}|` +
            block.rows.map((row) => `${row.length}|${row.map(part).join('')}`).join(''),
        )
        break
      case 'img':
        out.push(`img|${part(block.sha)}`)
        break
    }
  }
  return out.join('\n')
}

/** the content digest a signature commits to: 0x-prefixed 32-byte hex */
export function digestCanonical(doc: CanonicalDoc): `0x${string}` {
  const hex = createHash('sha256').update(serializeCanonical(doc), 'utf8').digest('hex')
  return `0x${hex}`
}
