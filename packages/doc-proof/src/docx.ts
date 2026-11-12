/**
 * Reduce a parsed .docx to its canonical form.
 *
 * This is the only place that knows about the docx model. Adding another
 * format means adding a sibling that produces the same CanonicalDoc — the
 * attestation, the sidecar and verification never change.
 *
 * The mapping is deliberately lossy in one direction only: everything that
 * survives into the canonical form is content a reader would notice changing.
 * See canonical.ts for the rule, and docs/document-proofs.md for the user-
 * facing version of the same promise.
 */
import type { Block, Run, TableCell } from '@genoffice/docx-engine'
import {
  hashBytes,
  normalizeText,
  STRIKE_CLOSE,
  STRIKE_OPEN,
  type CanonicalBlock,
  type CanonicalDoc,
} from './canonical'

/**
 * Join a paragraph's runs into one string.
 *
 * Run boundaries are an encoding detail — Word splits a sentence across runs
 * for spell-check state, rsids and formatting, and re-saving reshuffles them —
 * so the runs are concatenated before normalising, never normalised
 * individually. Struck-through runs are fenced, because deleting a clause by
 * striking it through changes what the document says.
 */
export function runsToText(runs: readonly Run[] | undefined): string {
  if (!runs || runs.length === 0) return ''
  let out = ''
  for (const run of runs) {
    const text = run.text ?? ''
    if (text === '') continue
    out += run.strike ? `${STRIKE_OPEN}${text}${STRIKE_CLOSE}` : text
  }
  return normalizeText(out)
}

function cellText(cell: TableCell): string {
  // richParas is the formatting source of truth when present; paras is the
  // plain mirror. Either way the cell's text is what matters here.
  const rich = cell.richParas
  if (rich && rich.length > 0) {
    return normalizeText(rich.map((para) => runsToText(para.runs)).join(' '))
  }
  return normalizeText((cell.paras ?? []).join(' '))
}

/** strip the `data:<mime>;base64,` prefix and decode; null when it is not base64 data */
function decodeDataUrl(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  if (!/;base64$/i.test(dataUrl.slice(0, comma).replace(/^data:[^;]*/i, ''))) return null
  try {
    return new Uint8Array(Buffer.from(dataUrl.slice(comma + 1), 'base64'))
  } catch {
    return null
  }
}

/**
 * Build the canonical form from the blocks of a parsed document.
 *
 * Passthrough blocks (charts, OLE embeds, shapes the editor keeps as raw XML)
 * contribute their preview text when they have one. They are content a reader
 * sees, so leaving them out entirely would let a chart be swapped without
 * breaking a signature.
 */
export function canonicalFromBlocks(blocks: readonly Block[]): CanonicalDoc {
  const out: CanonicalBlock[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push({ k: 'h', lvl: block.level ?? 1, t: runsToText(block.runs) })
        break
      case 'listItem':
        out.push({ k: 'li', lvl: (block.list?.ilvl ?? 0) + 1, t: runsToText(block.runs) })
        break
      case 'paragraph':
        out.push({ k: 'p', t: runsToText(block.runs) })
        break
      case 'table': {
        const rows = (block.table?.rows ?? []).map((row) => row.map(cellText))
        out.push({ k: 'tbl', rows })
        break
      }
      case 'image': {
        const bytes = block.imageDataUrl ? decodeDataUrl(block.imageDataUrl) : null
        // an undecodable picture still has to occupy a slot, or removing it
        // would be invisible to the digest
        out.push({ k: 'img', sha: bytes ? hashBytes(bytes) : '' })
        break
      }
      case 'passthrough': {
        const text = normalizeText(block.previewText ?? block.label ?? '')
        out.push({ k: 'p', t: text })
        break
      }
    }
  }
  return { v: 1, blocks: out }
}
