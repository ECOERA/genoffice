import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpManager } from '@genoffice/mcp-client'

/**
 * The bundled Veo server, driven through the real MCP client against a fake
 * long-running-operation API: start, poll, download, and the error paths.
 */
const SCRIPT = resolve(__dirname, '..', 'mcp-servers', 'veo.mjs')
const CLIP = Buffer.from('not-really-an-mp4-but-bytes')

interface FakeVeo {
  server: Server
  base: string
  requests: {
    method: string
    url: string
    key: string | undefined
    body: Record<string, unknown>
  }[]
  pollsUntilDone: number
  polls: number
  mode: 'ok' | 'reject' | 'filtered'
}

function fakeVeo(): Promise<FakeVeo> {
  const state: FakeVeo = {
    server: null as never,
    base: '',
    requests: [],
    pollsUntilDone: 2,
    polls: 0,
    mode: 'ok',
  }
  state.server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const url = req.url ?? ''
      state.requests.push({
        method: req.method ?? '',
        url,
        key: req.headers['x-goog-api-key'] as string | undefined,
        body: raw ? JSON.parse(raw) : {},
      })
      if (url.endsWith(':predictLongRunning')) {
        res.setHeader('content-type', 'application/json')
        if (state.mode === 'reject') {
          res.writeHead(400).end(JSON.stringify({ error: { message: 'API key not valid' } }))
          return
        }
        res.end(JSON.stringify({ name: 'models/veo-3.1-fast-generate-preview/operations/op-1' }))
        return
      }
      if (url.includes('/operations/op-1')) {
        res.setHeader('content-type', 'application/json')
        state.polls++
        if (state.polls < state.pollsUntilDone) {
          res.end(JSON.stringify({ name: 'op-1', done: false }))
          return
        }
        if (state.mode === 'filtered') {
          res.end(
            JSON.stringify({
              done: true,
              response: { generateVideoResponse: { raiMediaFilteredReasons: ['violence'] } },
            }),
          )
          return
        }
        res.end(
          JSON.stringify({
            done: true,
            response: {
              generateVideoResponse: {
                generatedSamples: [{ video: { uri: `${state.base}/download/clip.mp4` } }],
              },
            },
          }),
        )
        return
      }
      if (url.startsWith('/download/')) {
        res.setHeader('content-type', 'video/mp4')
        res.end(CLIP)
        return
      }
      res.writeHead(404).end()
    })
  })
  return new Promise((r) =>
    state.server.listen(0, '127.0.0.1', () => {
      state.base = `http://127.0.0.1:${(state.server.address() as { port: number }).port}`
      r(state)
    }),
  )
}

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function managerFor(
  envFor: (dir: string) => Record<string, string>,
): Promise<{ m: McpManager; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'veo-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const env = { GEMINI_API_KEY: '', ...envFor(dir) }
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify({ mcpServers: { veo: { command: process.execPath, args: [SCRIPT], env } } }),
  )
  const m = new McpManager({
    configPath: join(dir, 'mcp.json'),
    permissions: { isAllowed: () => true, ask: async () => 'always', remember: () => {} },
    connectTimeoutMs: 15_000,
    callTimeoutMs: 20_000,
  })
  cleanup.push(() => m.stop())
  await m.start()
  return { m, dir }
}

describe('veo MCP server', () => {
  it('starts a job, polls it to completion, and hands back the clip URL', async () => {
    const veo = await fakeVeo()
    cleanup.push(() => veo.server.close())
    const { m, dir } = await managerFor((d) => ({
      GEMINI_API_KEY: 'k-test',
      GEMINI_API_BASE: veo.base,
      DUNEOFFICE_IMAGE_DIR: join(d, 'media'),
      DUNEOFFICE_IMAGE_URL_BASE: 'http://127.0.0.1:1/tok',
    }))
    expect(m.listTools().map((t) => t.name)).toEqual([
      'mcp__veo__generate_video',
      'mcp__veo__video_status',
    ])
    const started = await m.callTool('mcp__veo__generate_video', {
      prompt: 'a sandworm surfaces at dusk',
      duration_seconds: 4,
      resolution: '1080p',
      negative_prompt: 'text, watermark',
    })
    expect(started.isError).toBe(false)
    const jobId = /job ([0-9a-f]{8}) started/.exec(started.output)?.[1]
    expect(jobId).toBeTruthy()
    const start = veo.requests[0]
    expect(start.url).toBe('/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning')
    expect(start.key).toBe('k-test')
    expect(start.body).toEqual({
      instances: [{ prompt: 'a sandworm surfaces at dusk' }],
      parameters: {
        aspectRatio: '16:9',
        durationSeconds: 4,
        resolution: '1080p',
        negativePrompt: 'text, watermark',
      },
    })

    // first status call: not done yet (wait 0 → answer at once)
    const pending = await m.callTool('mcp__veo__video_status', { job_id: jobId, wait_seconds: 0 })
    expect(pending.isError).toBe(false)
    expect(pending.output).toContain('still rendering')
    // second: done → downloaded into the store with the key header
    const done = await m.callTool('mcp__veo__video_status', { job_id: jobId, wait_seconds: 0 })
    expect(done.isError).toBe(false)
    expect(done.output).toMatch(
      /Insert it with insert_video using this url: http:\/\/127\.0\.0\.1:1\/tok\/veo-[0-9a-f-]+\.mp4/,
    )
    expect(done.output).toContain('4 s, 1080p')
    const files = readdirSync(join(dir, 'media'))
    expect(files).toHaveLength(1)
    expect(readFileSync(join(dir, 'media', files[0])).equals(CLIP)).toBe(true)
    const download = veo.requests.find((r) => r.url.startsWith('/download/'))
    expect(download?.key).toBe('k-test')
    // the job is gone once delivered
    expect(
      (await m.callTool('mcp__veo__video_status', { job_id: jobId, wait_seconds: 0 })).isError,
    ).toBe(true)
  })

  it('sends a reference image as the first frame', async () => {
    const veo = await fakeVeo()
    cleanup.push(() => veo.server.close())
    const { m, dir } = await managerFor((d) => ({
      GEMINI_API_KEY: 'k',
      GEMINI_API_BASE: veo.base,
      DUNEOFFICE_IMAGE_DIR: join(d, 'media'),
      DUNEOFFICE_IMAGE_URL_BASE: 'http://127.0.0.1:1/tok',
    }))
    // an image "generated earlier" sits in the store; the URL form resolves to it locally
    mkdirSync(join(dir, 'media'), { recursive: true })
    writeFileSync(join(dir, 'media', 'nano-banana-1.png'), Buffer.from('png-bytes'))
    const r = await m.callTool('mcp__veo__generate_video', {
      prompt: 'the dune shifts in the wind',
      reference_image_url: 'http://127.0.0.1:1/tok/nano-banana-1.png',
    })
    expect(r.isError).toBe(false)
    const body = veo.requests[0].body as {
      instances: { image?: { mimeType: string; bytesBase64Encoded: string } }[]
    }
    expect(body.instances[0].image).toEqual({
      mimeType: 'image/png',
      bytesBase64Encoded: Buffer.from('png-bytes').toString('base64'),
    })
  })

  it('reports a missing key, a rejected request, an unknown job, and a filtered result', async () => {
    const veo = await fakeVeo()
    cleanup.push(() => veo.server.close())
    const noKey = await managerFor(() => ({ GEMINI_API_BASE: veo.base }))
    const r1 = await noKey.m.callTool('mcp__veo__generate_video', { prompt: 'x' })
    expect(r1).toMatchObject({ isError: true })
    expect(r1.output).toContain('GEMINI_API_KEY')

    const { m } = await managerFor(() => ({ GEMINI_API_KEY: 'k', GEMINI_API_BASE: veo.base }))
    veo.mode = 'reject'
    const r2 = await m.callTool('mcp__veo__generate_video', { prompt: 'x' })
    expect(r2).toMatchObject({ isError: true })
    expect(r2.output).toContain('API key not valid')
    expect((await m.callTool('mcp__veo__video_status', { job_id: 'nope' })).isError).toBe(true)

    veo.mode = 'filtered'
    veo.polls = 0
    veo.pollsUntilDone = 1
    const started = await m.callTool('mcp__veo__generate_video', { prompt: 'x' })
    const jobId = /job ([0-9a-f]{8}) started/.exec(started.output)?.[1]
    const r3 = await m.callTool('mcp__veo__video_status', { job_id: jobId, wait_seconds: 0 })
    expect(r3).toMatchObject({ isError: true })
    expect(r3.output).toContain('violence')
  })
})
