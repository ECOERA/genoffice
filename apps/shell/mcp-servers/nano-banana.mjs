#!/usr/bin/env node
/**
 * Nano Banana Pro (Google Gemini image models) as an MCP server over stdio.
 *
 * Dependency-free on purpose: it runs under the app's own Electron binary in
 * node mode, under plain `node`, and under Claude Code / Claude Desktop, with
 * nothing to install. The wire format is MCP's newline-delimited JSON-RPC.
 * The request mirrors the google-genai SDK call the nano-banana.py CLI makes
 * (generateContent with responseModalities + imageConfig), and the prompt
 * follows the nano-banana-prompt skill: a sentence plus a "Specifications"
 * JSON block (style / technical / materials / environment / composition /
 * quality, optionally preserve / change / avoid), with named presets.
 *
 * Environment:
 *   GEMINI_API_KEY             required (aistudio.google.com)
 *   NANO_BANANA_MODEL          default gemini-3-pro-image-preview (Nano Banana Pro);
 *                              gemini-2.5-flash-image is the cheaper, faster model
 *   NANO_BANANA_PRESETS        JSON file of presets (default: nano-banana-presets.json next to this file)
 *   GEMINI_API_BASE            default https://generativelanguage.googleapis.com
 *   DUNEOFFICE_IMAGE_DIR       where generated files go (set by DuneOffice)
 *   DUNEOFFICE_IMAGE_URL_BASE  http origin+prefix DuneOffice serves that dir from;
 *                              results then carry an http URL the editors can insert
 *   NANO_BANANA_OUTPUT_DIR     fallback dir when DUNEOFFICE_IMAGE_DIR is unset
 */
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const SERVER = { name: 'nano-banana', version: '1.1.0' }
const MODEL = process.env.NANO_BANANA_MODEL || 'gemini-3-pro-image-preview'
const API_BASE = (
  process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com'
).replace(/\/+$/, '')
const OUT_DIR =
  process.env.DUNEOFFICE_IMAGE_DIR ||
  process.env.NANO_BANANA_OUTPUT_DIR ||
  join(homedir(), '.genoffice', 'images')
const URL_BASE = (process.env.DUNEOFFICE_IMAGE_URL_BASE || '').replace(/\/+$/, '')
const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const IMAGE_SIZES = ['1K', '2K', '4K']
const SPEC_SECTIONS = ['style', 'technical', 'materials', 'environment', 'composition', 'quality']

function loadPresets() {
  const path =
    process.env.NANO_BANANA_PRESETS ||
    join(dirname(fileURLToPath(import.meta.url)), 'nano-banana-presets.json')
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
const PRESETS = loadPresets()

const sectionSchema = (description) => ({
  type: 'object',
  description,
  additionalProperties: { type: 'string' },
})

function tools() {
  const presetNames = Object.keys(PRESETS)
  return [
    {
      name: 'generate_image',
      description:
        'Generate (or edit) an image with Google Nano Banana Pro. Returns the saved file and, inside DuneOffice, an http URL that the editor image tools (insert_web_image, insert_image, replace_image) accept. ' +
        "Write `prompt` as one clear sentence about the subject, then put the look into `spec`, the structure Nano Banana Pro responds to best: style {primary: photorealistic|cinematic|editorial|product photography|documentary|portrait|architectural|lifestyle|minimalist|nordic|industrial|vintage|futuristic, lighting: natural|studio|golden hour|blue hour|dramatic|soft diffused|hard shadows|rim light|backlit|overcast|window light|neon, mood}, technical {aperture: f/1.4 (very blurred background) … f/2.8 (portrait) … f/5.6 … f/11 (all sharp) … f/16 (landscape), depth_of_field: shallow|medium|deep|infinite, exposure}, materials {primary, secondary, texture}, environment {location, time_of_day: dawn|morning|midday|afternoon|golden hour|sunset|blue hour|night|overcast, weather}, composition {framing: rule of thirds|centered|symmetrical|diagonal|golden ratio|leading lines|frame within frame, angle: eye level|low angle|high angle|bird's eye|worm's eye|dutch angle|over the shoulder, focus_subject}, quality {resolution, sharpness, post_processing: cinematic grading|natural|high contrast|desaturated|warm tones|cool tones|HDR}. Avoid contradictions (e.g. low-light with bright exposure). " +
        (presetNames.length
          ? `A \`preset\` fills the spec with a ready-made look (${presetNames.join(', ')}); spec values override it. `
          : '') +
        'For edits pass reference_image_urls and describe what to preserve and change. Use aspect_ratio 16:9 for slides; image_size 2K suits documents, 4K print.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'What to draw or change, as one clear sentence (English works best)',
          },
          spec: {
            type: 'object',
            description:
              'Structured look of the image; every field is optional, values are short phrases',
            properties: {
              style: sectionSchema('primary, lighting, mood, rendering_quality'),
              technical: sectionSchema('aperture, depth_of_field, exposure'),
              materials: sectionSchema('primary, secondary, texture'),
              environment: sectionSchema('location, time_of_day, weather'),
              composition: sectionSchema('framing, angle, focus_subject'),
              quality: sectionSchema('resolution, sharpness, post_processing'),
              preserve: {
                type: 'array',
                items: { type: 'string' },
                description: 'when editing: elements that must stay exactly as they are',
              },
              change: {
                type: 'array',
                items: { type: 'string' },
                description: 'when editing: the additions or changes to make',
              },
              avoid: {
                type: 'array',
                items: { type: 'string' },
                description: 'things to leave out',
              },
              include: {
                type: 'array',
                items: { type: 'string' },
                description: 'things that must appear',
              },
            },
          },
          ...(presetNames.length
            ? {
                preset: {
                  type: 'string',
                  enum: presetNames,
                  description: 'Ready-made spec to start from; spec fields override it',
                },
              }
            : {}),
          aspect_ratio: {
            type: 'string',
            enum: ASPECT_RATIOS,
            description: 'Output aspect ratio, default 1:1',
          },
          image_size: {
            type: 'string',
            enum: IMAGE_SIZES,
            description: 'Output resolution, default 2K',
          },
          reference_image_urls: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Images to edit, blend or take as reference: http(s) URLs, or URLs of images this server generated earlier. One image = edit it; several = blend them (refer to them as image 1, image 2 in the prompt)',
          },
          use_search: {
            type: 'boolean',
            description:
              'Ground the generation in Google Search results (real places, products, current events)',
          },
        },
        required: ['prompt'],
      },
    },
  ]
}

// ── JSON-RPC over stdio ───────────────────────────────────

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (id === undefined) return
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER,
      })
      return
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, { tools: tools() })
      return
    case 'tools/call':
      try {
        reply(id, await callTool(params?.name, params?.arguments ?? {}))
      } catch (err) {
        reply(id, { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true })
      }
      return
    default:
      replyError(id, -32601, `Method not found: ${method}`)
  }
}

// ── Prompt building (nano-banana-prompt skill / nano-banana.py) ──

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function stringList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string')
    return v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  return []
}

/** preset (if any) under the caller's spec, sections merged key by key */
export function buildSpec({ spec, preset, referenceCount }) {
  const base = isObject(PRESETS[preset]) ? PRESETS[preset] : {}
  const given = isObject(spec) ? spec : {}
  const out = {
    task:
      referenceCount > 1 ? 'blend_images' : referenceCount === 1 ? 'edit_image' : 'generate_image',
  }
  for (const section of SPEC_SECTIONS) {
    const merged = {
      ...(isObject(base[section]) ? base[section] : {}),
      ...(isObject(given[section]) ? given[section] : {}),
    }
    if (Object.keys(merged).length) out[section] = merged
  }
  const preserve = stringList(given.preserve)
  if (preserve.length) out.preserve = { elements: preserve, strict: true }
  const change = stringList(given.change)
  if (change.length) out.change = { elements: change }
  const include = stringList(given.include)
  const avoid = stringList(given.avoid)
  if (include.length || avoid.length) {
    out.quality = {
      ...(out.quality ?? {}),
      ...(include.length ? { include } : {}),
      ...(avoid.length ? { avoid } : {}),
    }
  }
  return out
}

export function buildPromptText(prompt, spec) {
  const hasSpec = Object.keys(spec).length > 1 // more than "task"
  return hasSpec ? `${prompt}\n\nSpecifications:\n${JSON.stringify(spec, null, 2)}` : prompt
}

// ── Tools ─────────────────────────────────────────────────

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

async function loadReference(ref) {
  if (URL_BASE && ref.startsWith(URL_BASE + '/')) {
    const name = decodeURIComponent(ref.slice(URL_BASE.length + 1)).replace(/[\\/]/g, '')
    const data = readFileSync(join(OUT_DIR, name))
    const ext = extname(name).toLowerCase()
    return {
      mimeType:
        ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : 'image/png',
      data: data.toString('base64'),
    }
  }
  if (!/^https?:\/\//.test(ref)) throw new Error('reference_image_urls must be http(s) URLs')
  const res = await fetch(ref)
  if (!res.ok) throw new Error(`Could not fetch the reference image (HTTP ${res.status})`)
  const mimeType = (res.headers.get('content-type') || 'image/png').split(';')[0]
  return { mimeType, data: Buffer.from(await res.arrayBuffer()).toString('base64') }
}

async function callTool(name, args) {
  if (name !== 'generate_image') return textResult(`Unknown tool: ${name}`, true)
  const key = process.env.GEMINI_API_KEY
  if (!key) {
    return textResult(
      'GEMINI_API_KEY is not set. Add it to this server\'s "env" in mcp.json (get a key at aistudio.google.com).',
      true,
    )
  }
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) return textResult('prompt must not be empty', true)
  const refs = [
    ...stringList(args.reference_image_urls),
    ...(typeof args.reference_image_url === 'string' ? [args.reference_image_url.trim()] : []),
  ].filter(Boolean)
  const spec = buildSpec({ spec: args.spec, preset: args.preset, referenceCount: refs.length })
  const parts = [{ text: buildPromptText(prompt, spec) }]
  for (const ref of refs) {
    const image = await loadReference(ref)
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } })
  }
  const aspectRatio = ASPECT_RATIOS.includes(args.aspect_ratio) ? args.aspect_ratio : '1:1'
  const imageSize = IMAGE_SIZES.includes(args.image_size) ? args.image_size : '2K'
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio, imageSize },
    },
    ...(args.use_search === true ? { tools: [{ google_search: {} }] } : {}),
  }
  const res = await fetch(
    `${API_BASE}/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    },
  )
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = json?.error?.message || res.statusText || `HTTP ${res.status}`
    return textResult(`Nano Banana request failed: ${detail}`, true)
  }
  const candidates = json.candidates ?? []
  const responseParts = candidates[0]?.content?.parts ?? []
  const image = responseParts.find((p) => p.inlineData?.data || p.inline_data?.data)
  if (!image) {
    const blocked = candidates[0]?.finishReason || json.promptFeedback?.blockReason
    const text = responseParts
      .map((p) => p.text)
      .filter(Boolean)
      .join(' ')
    return textResult(
      `Nano Banana returned no image${blocked ? ` (${blocked})` : ''}${text ? `: ${text}` : '.'}`,
      true,
    )
  }
  const inline = image.inlineData ?? image.inline_data
  const mimeType = inline.mimeType ?? inline.mime_type ?? 'image/png'
  const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png'
  mkdirSync(OUT_DIR, { recursive: true })
  const fileName = `nano-banana-${randomUUID()}.${ext}`
  const filePath = join(OUT_DIR, fileName)
  writeFileSync(filePath, Buffer.from(inline.data, 'base64'))
  const note = responseParts
    .map((p) => p.text)
    .filter(Boolean)
    .join(' ')
    .trim()
  if (URL_BASE) {
    return {
      content: [
        {
          type: 'text',
          text: `Image generated and saved. Insert it with the editor's image tool using this url: ${URL_BASE}/${fileName}${note ? `\nModel note: ${note}` : ''}`,
        },
      ],
    }
  }
  return {
    content: [
      { type: 'text', text: `Image generated: ${filePath}${note ? `\nModel note: ${note}` : ''}` },
      { type: 'image', mimeType, data: inline.data },
    ],
  }
}

// ── main ──────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    replyError(null, -32700, 'Parse error')
    return
  }
  void handle(msg).catch((err) => {
    if (msg?.id !== undefined) replyError(msg.id, -32603, String(err?.message ?? err))
  })
})
rl.on('close', () => process.exit(0))
