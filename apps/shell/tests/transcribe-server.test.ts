import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTranscribeServer,
  Transcriber,
  transcriptPrompt,
} from '../src/main/hosted/transcribe'

/** Transcription against a fake Gemini: inline path, Files API path, and error handling. */

let server: Server | null = null
let base = ''
const requests: {
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}[] = []
const cleanup: (() => void)[] = []
afterEach(() => {
  server?.close()
  server = null
  requests.length = 0
  for (const fn of cleanup.splice(0).reverse()) fn()
})

function fake(): Promise<void> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = req.url ?? ''
      requests.push({ url, headers: req.headers, body: body.toString('latin1').slice(0, 5000) })
      res.setHeader('content-type', 'application/json')
      if (
        url.startsWith('/upload/v1beta/files') &&
        req.headers['x-goog-upload-command'] === 'start'
      ) {
        res.setHeader('x-goog-upload-url', `${base}/upload-session/abc`)
        res.end('{}')
        return
      }
      if (url.startsWith('/upload-session/')) {
        res.end(
          JSON.stringify({
            file: { name: 'files/abc', uri: `${base}/files/abc`, state: 'ACTIVE' },
          }),
        )
        return
      }
      if (url.includes(':generateContent')) {
        const parsed = JSON.parse(body.toString('utf8')) as {
          contents: { parts: Record<string, unknown>[] }[]
        }
        const media = parsed.contents[0]!.parts[1]!
        const via = 'inline_data' in media ? 'inline' : 'file'
        if (req.headers['x-goog-api-key'] === 'bad') {
          res.writeHead(400).end(JSON.stringify({ error: { message: 'API key not valid' } }))
          return
        }
        res.end(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: `[00:00] Speaker 1: Hej (${via})` }] } }],
          }),
        )
        return
      }
      res.writeHead(404).end()
    })
  })
  return new Promise((r) =>
    server!.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`
      r()
    }),
  )
}

function recording(name: string, bytes: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, name)
  writeFileSync(path, Buffer.alloc(bytes, 1))
  return path
}

describe('transcribe', () => {
  it('builds the prompt from the options', () => {
    expect(transcriptPrompt({ speakers: true, timestamps: true, language: 'Swedish' })).toContain(
      'in Swedish',
    )
    expect(transcriptPrompt({ speakers: false, timestamps: false })).not.toContain('Speaker 1')
    expect(
      transcriptPrompt({ speakers: true, timestamps: false, instructions: 'Names: Palle, David' }),
    ).toContain('Names: Palle, David')
  })

  it('sends small files inline and large ones through the Files API', async () => {
    await fake()
    const t = new Transcriber({ apiBase: base, inlineLimit: 1000 })
    const tools = createTranscribeServer(t).tools
    const ctx = { env: { GEMINI_API_KEY: 'k' }, log: () => {} }
    const run = (args: Record<string, unknown>) => tools[0]!.run(args, ctx)
    const small = String(await run({ path: recording('memo.m4a', 500), language: 'Swedish' }))
    expect(small).toContain('Transcript of memo.m4a (gemini-2.5-flash):')
    expect(small).toContain('Speaker 1: Hej (inline)')
    const gen = requests.find((r) => r.url.includes(':generateContent'))!
    expect(gen.headers['x-goog-api-key']).toBe('k')
    expect(gen.body).toContain('"mime_type":"audio/mp4"')
    expect(gen.body).toContain('in Swedish')

    requests.length = 0
    const large = String(await run({ path: recording('meeting.mp3', 5000), speakers: false }))
    expect(large).toContain('Speaker 1: Hej (file)')
    expect(requests.map((r) => r.url)).toEqual([
      '/upload/v1beta/files',
      '/upload-session/abc',
      '/v1beta/models/gemini-2.5-flash:generateContent',
    ])
    expect(requests[0]!.headers['x-goog-upload-header-content-type']).toBe('audio/mpeg')
    expect(requests[1]!.headers['x-goog-upload-command']).toBe('upload, finalize')
    expect(requests[2]!.body).toContain(`"file_uri":"${base}/files/abc"`)
  })

  it('reports a missing key, an unsupported type, a missing file and an API error', async () => {
    await fake()
    const tools = createTranscribeServer(new Transcriber({ apiBase: base })).tools
    const noKey = await tools[0]!.run({ path: 'x.mp3' }, { env: {}, log: () => {} })
    expect(noKey).toMatchObject({ isError: true })
    const ctx = { env: { GEMINI_API_KEY: 'bad' }, log: () => {} }
    await expect(tools[0]!.run({ path: recording('notes.txt', 10) }, ctx)).rejects.toThrow(
      /Unsupported file type/,
    )
    await expect(tools[0]!.run({ path: '/nope/missing.mp3' }, ctx)).rejects.toThrow(/ENOENT/)
    await expect(tools[0]!.run({ path: recording('a.wav', 10) }, ctx)).rejects.toThrow(
      /API key not valid/,
    )
  })
})
