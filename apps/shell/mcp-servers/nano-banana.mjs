#!/usr/bin/env node
/**
 * Nano Banana (Google Gemini image models) as an MCP server over stdio.
 *
 * Dependency-free on purpose: it runs under the app's own Electron binary in
 * node mode, under plain `node`, and under Claude Code / Claude Desktop, with
 * nothing to install. The wire format is MCP's newline-delimited JSON-RPC.
 *
 * Environment:
 *   GEMINI_API_KEY             required (aistudio.google.com)
 *   NANO_BANANA_MODEL          default gemini-2.5-flash-image
 *   GEMINI_API_BASE            default https://generativelanguage.googleapis.com
 *   DUNEOFFICE_IMAGE_DIR       where generated files go (set by DuneOffice)
 *   DUNEOFFICE_IMAGE_URL_BASE  http origin+prefix DuneOffice serves that dir from;
 *                              results then carry an http URL the editors can insert
 *   NANO_BANANA_OUTPUT_DIR     fallback dir when DUNEOFFICE_IMAGE_DIR is unset
 */
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SERVER = { name: 'nano-banana', version: '1.0.0' }
const MODEL = process.env.NANO_BANANA_MODEL || 'gemini-2.5-flash-image'
const API_BASE = (
  process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com'
).replace(/\/+$/, '')
const OUT_DIR =
  process.env.DUNEOFFICE_IMAGE_DIR ||
  process.env.NANO_BANANA_OUTPUT_DIR ||
  join(homedir(), '.genoffice', 'images')
const URL_BASE = (process.env.DUNEOFFICE_IMAGE_URL_BASE || '').replace(/\/+$/, '')
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9']

const TOOLS = [
  {
    name: 'generate_image',
    description:
      'Generate an image with Google Nano Banana (Gemini) from a text prompt. Returns the saved file and, inside DuneOffice, an http URL that the editor image tools (insert_web_image, insert_image, replace_image) accept. Describe subject, style, lighting and composition in the prompt; use aspect_ratio for slides (16:9) or portraits (3:4).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw, in detail (English works best)' },
        aspect_ratio: {
          type: 'string',
          enum: ASPECT_RATIOS,
          description: 'Output aspect ratio, default 1:1',
        },
        reference_image_url: {
          type: 'string',
          description:
            'Optional image to edit or take as reference: an http(s) URL, or a URL of an image this server generated earlier',
        },
      },
      required: ['prompt'],
    },
  },
]

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
      reply(id, { tools: TOOLS })
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
  if (!/^https?:\/\//.test(ref)) throw new Error('reference_image_url must be an http(s) URL')
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
  const aspectRatio = ASPECT_RATIOS.includes(args.aspect_ratio) ? args.aspect_ratio : undefined
  const parts = [{ text: prompt }]
  if (typeof args.reference_image_url === 'string' && args.reference_image_url.trim()) {
    const ref = await loadReference(args.reference_image_url.trim())
    parts.push({ inline_data: { mime_type: ref.mimeType, data: ref.data } })
  }
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
    },
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
