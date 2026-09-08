import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpManager } from '@genoffice/mcp-client'

/**
 * The bundled Nano Banana server, driven through the real MCP client against
 * a fake Gemini endpoint: request shape, file output, URL hand-off, errors.
 */
const SCRIPT = resolve(__dirname, '..', 'mcp-servers', 'nano-banana.mjs')
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

interface FakeGemini {
  server: Server
  base: string
  requests: { url: string; key: string | undefined; body: Record<string, unknown> }[]
  mode: 'image' | 'blocked' | 'unauthorized'
}

function fakeGemini(): Promise<FakeGemini> {
  const state: FakeGemini = { server: null as never, base: '', requests: [], mode: 'image' }
  state.server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      state.requests.push({
        url: req.url ?? '',
        key: req.headers['x-goog-api-key'] as string | undefined,
        body: JSON.parse(raw || '{}'),
      })
      res.setHeader('content-type', 'application/json')
      if (state.mode === 'unauthorized') {
        res.writeHead(400).end(JSON.stringify({ error: { message: 'API key not valid' } }))
      } else if (state.mode === 'blocked') {
        res.end(
          JSON.stringify({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }),
        )
      } else {
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'A dune at dusk.' },
                    { inlineData: { mimeType: 'image/png', data: PNG_B64 } },
                  ],
                },
              },
            ],
          }),
        )
      }
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
  const dir = mkdtempSync(join(tmpdir(), 'nano-banana-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  // a GEMINI_API_KEY in the developer's shell must not leak into the "no key" case
  const env = { GEMINI_API_KEY: '', ...envFor(dir) }
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify({
      mcpServers: { nano: { command: process.execPath, args: [SCRIPT], env } },
    }),
  )
  const m = new McpManager({
    configPath: join(dir, 'mcp.json'),
    permissions: { isAllowed: () => true, ask: async () => 'always', remember: () => {} },
    connectTimeoutMs: 15_000,
    callTimeoutMs: 15_000,
  })
  cleanup.push(() => m.stop())
  await m.start()
  return { m, dir }
}

describe('nano-banana MCP server', () => {
  it('generates an image, saves it, and hands back the DuneOffice image URL', async () => {
    const gemini = await fakeGemini()
    cleanup.push(() => gemini.server.close())
    const { m, dir } = await managerFor((d) => ({
      GEMINI_API_KEY: 'k-test',
      GEMINI_API_BASE: gemini.base,
      DUNEOFFICE_IMAGE_DIR: join(d, 'images'),
      DUNEOFFICE_IMAGE_URL_BASE: 'http://127.0.0.1:1/tok',
    }))
    expect(m.status()[0]).toMatchObject({ name: 'nano', state: 'ready', toolCount: 1 })
    expect(m.listTools()[0].name).toBe('mcp__nano__generate_image')
    const r = await m.callTool('mcp__nano__generate_image', {
      prompt: 'a sandworm at dusk',
      aspect_ratio: '16:9',
    })
    expect(r.isError).toBe(false)
    expect(r.output).toMatch(
      /using this url: http:\/\/127\.0\.0\.1:1\/tok\/nano-banana-[0-9a-f-]+\.png/,
    )
    expect(r.output).toContain('Model note: A dune at dusk.')
    const files = readdirSync(join(dir, 'images'))
    expect(files).toHaveLength(1)
    expect(existsSync(join(dir, 'images', files[0]))).toBe(true)
    const req = gemini.requests[0]
    expect(req.url).toBe('/v1beta/models/gemini-2.5-flash-image:generateContent')
    expect(req.key).toBe('k-test')
    expect(req.body).toMatchObject({
      contents: [{ parts: [{ text: 'a sandworm at dusk' }] }],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
        imageConfig: { aspectRatio: '16:9' },
      },
    })
  })

  it('returns the file path and the image itself when not running inside DuneOffice', async () => {
    const gemini = await fakeGemini()
    cleanup.push(() => gemini.server.close())
    const { m, dir } = await managerFor((d) => ({
      GEMINI_API_KEY: 'k',
      GEMINI_API_BASE: gemini.base,
      NANO_BANANA_OUTPUT_DIR: join(d, 'out'),
    }))
    const r = await m.callTool('mcp__nano__generate_image', { prompt: 'x' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain(`Image generated: ${join(dir, 'out')}`)
    // the image part came back and the client kept a placeholder for it (no sink here)
    expect(r.output).toContain('[image image/png:')
  })

  it('reports a missing key, a rejected key, and a blocked prompt as tool errors', async () => {
    const gemini = await fakeGemini()
    cleanup.push(() => gemini.server.close())
    const noKey = await managerFor(() => ({ GEMINI_API_BASE: gemini.base }))
    const r1 = await noKey.m.callTool('mcp__nano__generate_image', { prompt: 'x' })
    expect(r1).toMatchObject({ isError: true })
    expect(r1.output).toContain('GEMINI_API_KEY')
    expect(gemini.requests).toHaveLength(0)

    gemini.mode = 'unauthorized'
    const withKey = await managerFor(() => ({
      GEMINI_API_KEY: 'bad',
      GEMINI_API_BASE: gemini.base,
    }))
    const r2 = await withKey.m.callTool('mcp__nano__generate_image', { prompt: 'x' })
    expect(r2).toMatchObject({ isError: true })
    expect(r2.output).toContain('API key not valid')

    gemini.mode = 'blocked'
    const r3 = await withKey.m.callTool('mcp__nano__generate_image', { prompt: 'x' })
    expect(r3).toMatchObject({ isError: true })
    expect(r3.output).toContain('SAFETY')
  })
})
