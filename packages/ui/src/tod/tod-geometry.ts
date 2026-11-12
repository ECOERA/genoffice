/**
 * Geometry for Tod's body.
 *
 * The worm's segment rings have to sit exactly on the paperclip wire, or the
 * two readings of the character come apart. Rather than hand-placing them (and
 * re-placing them every time the path is nudged), the wire is described once
 * as typed segments here and the rings are sampled from it at even arc length.
 *
 * `SVGGeometryElement.getPointAtLength` would do this, but it needs a node in a
 * document — Tod must render correctly on first paint and in jsdom tests — so
 * the sampling is done in plain arithmetic instead.
 */

type Point = readonly [number, number]

type Segment =
  | { readonly kind: 'line'; readonly from: Point; readonly to: Point }
  /** SVG arc, given as a centre + radius + start/end angle (radians, y-down frame) */
  | {
      readonly kind: 'arc'
      readonly center: Point
      readonly radius: number
      readonly fromAngle: number
      readonly toAngle: number
    }
  | {
      readonly kind: 'cubic'
      readonly from: Point
      readonly c1: Point
      readonly c2: Point
      readonly to: Point
    }

/**
 * The wire, as a gem paperclip: inner leg up, bend over the top, down the
 * outer right, round the bottom, up the outer left, then the free end crests
 * and rears into the neck. `BODY_PATH` is the same curve as an SVG `d`, and
 * the two must stay in step — the unit test pins them together.
 */
export const BODY_PATH =
  'M 58 88 L 58 52 A 16 16 0 0 1 90 52 L 90 84 A 24 24 0 0 1 42 84 L 42 46 C 42 26 60 18 66 28'

const BODY_SEGMENTS: readonly Segment[] = [
  { kind: 'line', from: [58, 88], to: [58, 52] },
  // (58,52) → (90,52), sweeping clockwise over the top: angle π → 0 (y-down)
  { kind: 'arc', center: [74, 52], radius: 16, fromAngle: Math.PI, toAngle: 0 },
  { kind: 'line', from: [90, 52], to: [90, 84] },
  // (90,84) → (42,84), sweeping clockwise under the bottom: angle 0 → -π
  { kind: 'arc', center: [66, 84], radius: 24, fromAngle: 0, toAngle: -Math.PI },
  { kind: 'line', from: [42, 84], to: [42, 46] },
  { kind: 'cubic', from: [42, 46], c1: [42, 26], c2: [60, 18], to: [66, 28] },
]

/** where the neck ends and the head sits (the last segment's endpoint, lifted clear) */
export const HEAD_POS: Point = [67, 24]

/** crest of the sand mound; the bottom bend reaches y≈108, so ~4px of it is buried */
export const SAND_TOP = 104

function pointOn(segment: Segment, t: number): Point {
  if (segment.kind === 'line') {
    const [ax, ay] = segment.from
    const [bx, by] = segment.to
    return [ax + (bx - ax) * t, ay + (by - ay) * t]
  }
  if (segment.kind === 'arc') {
    const angle = segment.fromAngle + (segment.toAngle - segment.fromAngle) * t
    const [cx, cy] = segment.center
    // y is negated: SVG's y axis points down, the angles above are the usual maths convention
    return [cx + Math.cos(angle) * segment.radius, cy - Math.sin(angle) * segment.radius]
  }
  const u = 1 - t
  const [p0x, p0y] = segment.from
  const [p1x, p1y] = segment.c1
  const [p2x, p2y] = segment.c2
  const [p3x, p3y] = segment.to
  return [
    u * u * u * p0x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x,
    u * u * u * p0y + 3 * u * u * t * p1y + 3 * u * t * t * p2y + t * t * t * p3y,
  ]
}

interface Sample {
  x: number
  y: number
  /** arc length from the start of the path */
  at: number
}

/** dense polyline over the whole wire, with cumulative arc length */
function sampleBody(): readonly Sample[] {
  const samples: Sample[] = []
  let total = 0
  for (const segment of BODY_SEGMENTS) {
    const steps = 240
    for (let i = 0; i <= steps; i++) {
      const [x, y] = pointOn(segment, i / steps)
      const previous = samples[samples.length - 1]
      if (previous) {
        const step = Math.hypot(x - previous.x, y - previous.y)
        if (step === 0) continue
        total += step
      }
      samples.push({ x, y, at: total })
    }
  }
  return samples
}

const SAMPLES = sampleBody()
export const BODY_LENGTH = SAMPLES[SAMPLES.length - 1]!.at

/** the sample nearest a given arc length (binary search over the polyline) */
function pointAtLength(length: number): Sample {
  const target = Math.max(0, Math.min(BODY_LENGTH, length))
  let low = 0
  let high = SAMPLES.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (SAMPLES[mid]!.at < target) low = mid + 1
    else high = mid
  }
  return SAMPLES[low]!
}

/** one segment ring: a tick drawn across the wire, [x1, y1, x2, y2] */
export type Ring = readonly [number, number, number, number]

/** half-width of a ring; the wire is 15.5 wide, so this sits just inside the edge */
const RING_HALF_WIDTH = 5.9

/**
 * Evenly spaced rings across the wire. `count` rings divide the path into
 * count + 1 stretches, so none lands on the buried tail or on the head.
 */
export function bodyRings(count: number): readonly Ring[] {
  const rings: Ring[] = []
  for (let i = 1; i <= count; i++) {
    const at = (i / (count + 1)) * BODY_LENGTH
    const before = pointAtLength(at - 0.6)
    const after = pointAtLength(at + 0.6)
    const here = pointAtLength(at)
    // perpendicular to the local tangent
    const angle = Math.atan2(after.y - before.y, after.x - before.x) + Math.PI / 2
    const dx = Math.cos(angle) * RING_HALF_WIDTH
    const dy = Math.sin(angle) * RING_HALF_WIDTH
    rings.push([
      +(here.x + dx).toFixed(2),
      +(here.y + dy).toFixed(2),
      +(here.x - dx).toFixed(2),
      +(here.y - dy).toFixed(2),
    ])
  }
  return rings
}

/** how many rings Tod wears */
export const BODY_RING_COUNT = 16
