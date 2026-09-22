/**
 * Transcription — a hosted MCP server (see mcp-host.ts) that turns a
 * recording (meeting audio, voice memo, video) into a transcript with the
 * Gemini API: files up to 20 MB go inline, larger ones through the Files
 * API (resumable upload). The assistant then writes minutes, action items
 * or a summary with the editor's tools. Key: GEMINI_API_KEY from the
 * mcp.json entry env (the same key as nano-banana / veo).
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, resolve } from 'node:path'
import { textResult, type HostedContext, type HostedServer, type HostedTool } from '../mcp-host'

export interface TranscribeOptions {
  apiBase?: string
  model?: string
  /** inline limit in bytes (Gemini: 20 MB request size) */
  inlineLimit?: number
  timeoutMs?: number
}

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.aiff': 'audio/aiff',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
}
const MAX_BYTES = 2 * 1024 * 1024 * 1024

function expandHome(p: string): string {
  return resolve(p.startsWith('~') ? `${homedir()}${p.slice(1)}` : p)
}

type Json = Record<string, unknown>
const asRecord = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export function transcriptPrompt(opts: {
  language?: string
  speakers: boolean
  timestamps: boolean
  instructions?: string
}): string {
  const lines = [
    `Transcribe this recording verbatim${opts.language ? ` in ${opts.language}` : ' in its original language'}.`,
    'Keep every sentence; do not summarise. Write numbers as digits and keep names as spoken.',
  ]
  if (opts.speakers)
    lines.push(
      'Label speakers as "Speaker 1:", "Speaker 2:" (use names if they introduce themselves) and start a new paragraph when the speaker changes.',
    )
  if (opts.timestamps) lines.push('Start each paragraph with a [mm:ss] timestamp.')
  if (opts.instructions) lines.push(opts.instructions)
  lines.push('Output only the transcript.')
  return lines.join(' ')
}

export class Transcriber {
  private readonly base: string
  constructor(private readonly opts: TranscribeOptions = {}) {
    this.base = (opts.apiBase ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')
  }

  get model(): string {
    return this.opts.model ?? 'gemini-2.5-flash'
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 600_000)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /** Files API resumable upload → file uri usable in generateContent */
  async upload(key: string, data: Buffer, mimeType: string, name: string): Promise<string> {
    const start = await this.fetch(`${this.base}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(data.length),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: name } }),
    })
    const uploadUrl = start.headers.get('x-goog-upload-url')
    if (!start.ok || !uploadUrl) throw new Error(`Upload could not start (HTTP ${start.status})`)
    const done = await this.fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'Content-Length': String(data.length),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: new Uint8Array(data),
    })
    const json = asRecord(await done.json().catch(() => ({})))
    const file = asRecord(json.file)
    if (!done.ok || !file.uri) throw new Error(`Upload failed (HTTP ${done.status})`)
    // audio is usually ACTIVE at once; video may need processing
    let state = String(file.state ?? 'ACTIVE')
    let uri = String(file.uri)
    const fileName = String(file.name ?? '')
    for (let i = 0; state === 'PROCESSING' && i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      const probe = asRecord(
        await (
          await this.fetch(`${this.base}/v1beta/${fileName}`, {
            headers: { 'x-goog-api-key': key },
          })
        )
          .json()
          .catch(() => ({})),
      )
      state = String(probe.state ?? state)
      if (probe.uri) uri = String(probe.uri)
    }
    if (state === 'FAILED') throw new Error('Gemini could not process the file')
    return uri
  }

  async transcribe(key: string, path: string, prompt: string): Promise<string> {
    const full = expandHome(path)
    const st = statSync(full)
    if (st.size > MAX_BYTES) throw new Error('The file is larger than 2 GB')
    const mimeType = MIME[extname(full).toLowerCase()]
    if (!mimeType)
      throw new Error(
        `Unsupported file type ${extname(full) || '(none)'}; use mp3, m4a, wav, aac, ogg, flac, webm, mp4 or mov`,
      )
    const data = readFileSync(full)
    const limit = this.opts.inlineLimit ?? 20 * 1024 * 1024
    const media =
      data.length <= limit
        ? { inline_data: { mime_type: mimeType, data: data.toString('base64') } }
        : {
            file_data: {
              mime_type: mimeType,
              file_uri: await this.upload(key, data, mimeType, basename(full)),
            },
          }
    const res = await this.fetch(
      `${this.base}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, media] }],
          generationConfig: { temperature: 0.1 },
        }),
      },
    )
    const json = asRecord(await res.json().catch(() => ({})))
    if (!res.ok)
      throw new Error(
        `Gemini request failed: ${String(asRecord(json.error).message ?? res.statusText)}`,
      )
    const candidate = asRecord(asArray(json.candidates)[0])
    const text = asArray(asRecord(candidate.content).parts)
      .map((p) => String(asRecord(p).text ?? ''))
      .join('')
      .trim()
    if (!text)
      throw new Error(
        `Gemini returned no transcript${candidate.finishReason ? ` (${String(candidate.finishReason)})` : ''}`,
      )
    return text
  }
}

export function createTranscribeServer(transcriber: Transcriber): HostedServer {
  const tools: HostedTool[] = [
    {
      name: 'transcribe_audio',
      description:
        'Transcribe a recording on disk (meeting audio, voice memo, interview, video: mp3, m4a, wav, aac, ogg, flac, webm, mp4, mov) into text with speaker labels and timestamps. Takes roughly a tenth of the recording length. Then write the minutes, decisions and action items yourself with the editor tools; keep the transcript when the user wants it.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the recording (~ allowed)' },
          language: { type: 'string', description: 'e.g. Swedish, English; default: as spoken' },
          speakers: { type: 'boolean', description: 'Label speakers, default true' },
          timestamps: { type: 'boolean', description: '[mm:ss] per paragraph, default true' },
          instructions: {
            type: 'string',
            description: 'Extra guidance, e.g. names of participants or domain terms',
          },
        },
        required: ['path'],
      },
      run: async (args, ctx: HostedContext) => {
        const key = ctx.env.GEMINI_API_KEY
        if (!key)
          return textResult(
            'GEMINI_API_KEY is not set. Add it to the "transcribe" entry\'s env in mcp.json (aistudio.google.com).',
            true,
          )
        const path = String(args.path ?? '').trim()
        if (!path) return textResult('path is required', true)
        const prompt = transcriptPrompt({
          language:
            typeof args.language === 'string' && args.language.trim()
              ? args.language.trim()
              : undefined,
          speakers: args.speakers !== false,
          timestamps: args.timestamps !== false,
          instructions: typeof args.instructions === 'string' ? args.instructions : undefined,
        })
        const text = await transcriber.transcribe(key, path, prompt)
        return `Transcript of ${basename(expandHome(path))} (${transcriber.model}):\n\n${text}`
      },
    },
  ]
  return { name: 'transcribe', version: '1.0.0', tools }
}
