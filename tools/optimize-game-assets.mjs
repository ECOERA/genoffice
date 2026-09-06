#!/usr/bin/env node
/**
 * Shrinks a bundled HTML game's assets in place so the app stays small.
 *
 *   node tools/optimize-game-assets.mjs apps/shell/games/dune-adventure [sprites/sand_ground.png]
 *
 * Rules (the originals live outside the repo; rerun after replacing them):
 * - PNGs drawn whole are capped at PNG_MAX px on their longer side (sips).
 *   Tiling textures the game samples in fixed-pixel windows keep their size,
 *   because shrinking them changes the grain the player sees.
 * - Every PNG is palette-quantized with pngquant when a binary is available
 *   (PNGQUANT env, or the copy npx caches for `npx -y pngquant-bin`).
 * - Music above MP3_MIN_BYTES is re-encoded as VBR mp3 with ffmpeg; the
 *   result replaces the file only when it is smaller. Short effects stay.
 * macOS tooling (sips, ffmpeg from Homebrew); a no-op where a tool is missing.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.argv[2] ?? 'apps/shell/games/dune-adventure'
/** optional: only files whose relative path starts with this prefix */
const only = process.argv[3] ?? ''
const PNG_MAX = 1024
/** wide scrolling backgrounds keep more pixels than a tile-sized sprite */
const PNG_MAX_BY_PATH = { 'sprites/sand_ground.png': 2048 }
const TEXTURES = ['tiles/']
const MP3_MIN_BYTES = 1_000_000
const MP3_VBR_QUALITY = '6' // ~115 kbps average
const PNGQUANT = process.env.PNGQUANT ?? findPngquant()
const FFMPEG = which('ffmpeg')

function which(cmd) {
  const r = spawnSync('which', [cmd])
  return r.status === 0 ? r.stdout.toString().trim() : null
}
function findPngquant() {
  try {
    const dir = join(process.env.HOME ?? '', '.npm', '_npx')
    for (const d of readdirSync(dir)) {
      const p = join(dir, d, 'node_modules', 'pngquant-bin', 'vendor', 'pngquant')
      if (existsSync(p)) return p
    }
  } catch {
    // no npx cache
  }
  return null
}
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else yield p
  }
}
function dims(file) {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).toString()
  const w = Number(/pixelWidth: (\d+)/.exec(out)?.[1])
  const h = Number(/pixelHeight: (\d+)/.exec(out)?.[1])
  return { w, h }
}
const size = (f) => statSync(f).size
const mb = (n) => (n / 1048576).toFixed(1) + ' MB'

let before = 0
let after = 0
const rows = []
for (const file of walk(root)) {
  const rel = relative(root, file)
  if (only && !rel.startsWith(only)) continue
  const b = size(file)
  before += b
  let note = ''
  if (file.endsWith('.png')) {
    const texture = TEXTURES.some((t) => rel.startsWith(t))
    const { w, h } = dims(file)
    const cap = PNG_MAX_BY_PATH[rel] ?? PNG_MAX
    if (!texture && Math.max(w, h) > cap) {
      execFileSync('sips', ['-Z', String(cap), file, '--out', file], { stdio: 'ignore' })
      const d = dims(file)
      note += `${w}x${h}->${d.w}x${d.h} `
    } else if (texture) {
      note += 'texture '
    }
    if (PNGQUANT) {
      const r = spawnSync(PNGQUANT, [
        '--quality=70-95',
        '--speed',
        '1',
        '--strip',
        '--force',
        '--ext',
        '.png',
        '--',
        file,
      ])
      note +=
        r.status === 0
          ? 'quantized'
          : r.status === 99
            ? 'quantize skipped (quality floor)'
            : `pngquant exit ${r.status}`
    }
  } else if (file.endsWith('.mp3') && b >= MP3_MIN_BYTES && FFMPEG) {
    const tmp = file + '.tmp.mp3'
    const r = spawnSync(FFMPEG, [
      '-y',
      '-loglevel',
      'error',
      '-i',
      file,
      '-codec:a',
      'libmp3lame',
      '-q:a',
      MP3_VBR_QUALITY,
      tmp,
    ])
    if (r.status === 0 && size(tmp) < b) {
      renameSync(tmp, file)
      note += `mp3 vbr q${MP3_VBR_QUALITY}`
    } else {
      if (existsSync(tmp)) unlinkSync(tmp)
      note += 'mp3 kept'
    }
  }
  const a = size(file)
  after += a
  if (note) rows.push(`${mb(b).padStart(8)} -> ${mb(a).padStart(8)}  ${rel}  ${note}`)
}
console.log(rows.join('\n'))
console.log(
  `\ntotal ${mb(before)} -> ${mb(after)} (${root}); pngquant: ${PNGQUANT ? 'yes' : 'no'}, ffmpeg: ${FFMPEG ? 'yes' : 'no'}`,
)
