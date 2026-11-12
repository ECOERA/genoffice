/**
 * Night reading inverts the page bitmap, which would also turn photos and
 * figures into negatives. To keep them true to colour, each rendered page gets
 * an unfiltered overlay canvas holding just its image regions, copied from the
 * original rendering. pdf.js records where images are drawn (normalized to the
 * canvas) the first time a page renders with `recordImages` on. The overlay is
 * only shown in night mode (see `.pdf-night` in styles.css).
 *
 * Ported from Folio (https://github.com/Forward-Future/folio, MIT, © Matthew
 * Berman / Forward Future) — see NOTICE.
 */

interface PageLike {
  imageCoordinates?: ArrayLike<number> | null
}

export const IMAGE_OVERLAY_CLASS = 'pdf-image-overlay'

/** The page rotation in effect when pdf.js recorded a page's image positions. */
const capturedRotation = new WeakMap<object, number>()

function rotatePoint(x: number, y: number, delta: number): [number, number] {
  switch (delta) {
    case 90:
      return [1 - y, x]
    case 180:
      return [1 - x, 1 - y]
    case 270:
      return [y, 1 - x]
    default:
      return [x, y]
  }
}

export interface ImageRegion {
  /** Normalized to the page canvas (0–1), in the page's current rotation. */
  left: number
  top: number
  right: number
  bottom: number
}

/** Where images are drawn on a rendered page, normalized to its canvas (empty until pdf.js has recorded them). */
export function imageRegions(page: PageLike | null | undefined, rotation: number): ImageRegion[] {
  const coords = page?.imageCoordinates
  if (!page || !coords || coords.length < 6) return []
  if (!capturedRotation.has(page)) capturedRotation.set(page, rotation)
  const delta = (((rotation - capturedRotation.get(page)!) % 360) + 360) % 360
  const regions: ImageRegion[] = []
  for (let i = 0; i + 5 < coords.length; i += 6) {
    // Three corners of the image's parallelogram; the fourth follows from them.
    const p0: [number, number] = [coords[i]!, coords[i + 1]!]
    const p1: [number, number] = [coords[i + 2]!, coords[i + 3]!]
    const p2: [number, number] = [coords[i + 4]!, coords[i + 5]!]
    const p3: [number, number] = [p1[0] + p2[0] - p0[0], p1[1] + p2[1] - p0[1]]
    const pts = [p0, p1, p2, p3].map(([x, y]) => rotatePoint(x, y, delta))
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    regions.push({
      left: Math.max(0, Math.min(...xs)),
      top: Math.max(0, Math.min(...ys)),
      right: Math.min(1, Math.max(...xs)),
      bottom: Math.min(1, Math.max(...ys)),
    })
  }
  return regions
}

/**
 * Build the overlay canvas for `source` (same pixel size and CSS size), or
 * null when the page has no images worth keeping.
 */
export function buildImageOverlay(
  source: HTMLCanvasElement,
  page: PageLike | null | undefined,
  rotation: number,
): HTMLCanvasElement | null {
  const { width, height } = source
  if (!width || !height) return null
  const regions = imageRegions(page, rotation)
  if (regions.length === 0) return null
  const overlay = document.createElement('canvas')
  overlay.className = IMAGE_OVERLAY_CLASS
  overlay.setAttribute('aria-hidden', 'true')
  overlay.width = width
  overlay.height = height
  overlay.style.width = source.style.width
  overlay.style.height = source.style.height
  const ctx = overlay.getContext('2d')
  if (!ctx) return null
  let painted = false
  for (const r of regions) {
    const left = Math.floor(r.left * width)
    const top = Math.floor(r.top * height)
    const right = Math.ceil(r.right * width)
    const bottom = Math.ceil(r.bottom * height)
    if (right - left < 2 || bottom - top < 2) continue
    // A full-page image is a scan: keep inverting it like text, or a scanned
    // book would stay glaring white at night.
    if (r.right - r.left > 0.95 && r.bottom - r.top > 0.95) continue
    ctx.drawImage(
      source,
      left,
      top,
      right - left,
      bottom - top,
      left,
      top,
      right - left,
      bottom - top,
    )
    painted = true
  }
  return painted ? overlay : null
}
