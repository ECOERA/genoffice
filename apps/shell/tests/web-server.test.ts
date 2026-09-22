import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpManager } from '@genoffice/mcp-client'

/**
 * The bundled web server (search + read_page), driven through the real MCP
 * client against fake Brave / SearXNG / DuckDuckGo endpoints and a local page.
 */
const SCRIPT = resolve(__dirname, '..', 'mcp-servers', 'web.mjs')

const DDG_HTML = `<html><body>
<div class="result results_links_deep result--ad"><a class="result__a" href="https://ads.example/x">Sponsored thing</a>
  <a class="result__snippet" href="https://ads.example/x">buy now</a></div>
<div class="result results_links web-result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Feuropa.eu%2Fsoil&amp;rut=1">Soil <b>Monitoring</b> Law</a>
  <a class="result__snippet" href="/l/?uddg=x">The directive on soil &amp; monitoring…</a></div>
<div class="result results_links web-result"><a class="result__a" href="https://example.org/second">Second result</a></div>
</body></html>`

const PAGE_HTML = `<html><head><title>Soil &amp; Carbon</title><script>SCRIPTTEXT</script>
<style>.x{}</style></head><body><nav><a href="/">NAVLINK</a></nav>
<main><h1>Soil carbon</h1><p>First paragraph with <b>bold</b> text &ndash; and an entity: &auml;.</p>
<ul><li>item one</li><li>item two</li></ul>
<table><tr><td>a</td><td>b</td></tr></table>${'<p>filler paragraph. </p>'.repeat(60)}</main>
<footer>FOOTERTEXT</footer></body></html>`

interface Fake {
  server: Server
  base: string
  requests: { url: string; key: string | undefined }[]
}

function fake(): Promise<Fake> {
  const state: Fake = { server: null as never, base: '', requests: [] }
  state.server = createServer((req, res) => {
    const url = req.url ?? ''
    state.requests.push({ url, key: req.headers['x-subscription-token'] as string | undefined })
    const json = (body: unknown) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }
    if (url.startsWith('/brave-broken')) {
      res.writeHead(429).end(JSON.stringify({ message: 'quota exceeded' }))
      return
    }
    if (url.startsWith('/brave')) {
      json({
        web: {
          results: [
            {
              title: 'A <strong>strong</strong> title',
              url: 'https://europa.eu/one',
              description: 'Desc <strong>x</strong> &amp; more',
              age: '2 days ago',
            },
            { title: 'Two', url: 'https://example.org/two', description: 'second' },
          ],
        },
      })
      return
    }
    if (url.startsWith('/searx/search')) {
      json({
        results: [
          {
            title: 'Searx hit',
            url: 'https://sx.example/a',
            content: 'content here',
            publishedDate: '2026-09-01',
          },
        ],
      })
      return
    }
    if (url.startsWith('/ddg/')) {
      res.setHeader('content-type', 'text/html')
      res.end(DDG_HTML)
      return
    }
    if (url.startsWith('/lite/')) {
      res.setHeader('content-type', 'text/html')
      res.end(
        '<table><tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example%2Fone" class="result-link">Lite one</a></td></tr>' +
          '<tr><td class="result-snippet">first lite snippet</td></tr>' +
          '<tr><td><a rel="nofollow" href="https://lite.example/two" class="result-link">Lite two</a></td></tr>' +
          '<tr><td class="result-snippet">second</td></tr></table>',
      )
      return
    }
    if (url.startsWith('/ddg-challenge/')) {
      res.setHeader('content-type', 'text/html')
      res.end('<html><body><form id="challenge-form">anomaly detected</form></body></html>')
      return
    }
    if (url === '/redirect') {
      res.writeHead(302, { location: '/page' }).end()
      return
    }
    if (url === '/page') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(PAGE_HTML)
      return
    }
    if (url === '/pdf') {
      res.setHeader('content-type', 'application/pdf')
      res.end(Buffer.from('%PDF-1.7 fake'))
      return
    }
    if (url === '/text') {
      res.setHeader('content-type', 'text/plain')
      res.end('just   plain\n\n\n\ntext')
      return
    }
    res.writeHead(404).end()
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

async function managerFor(env: Record<string, string>): Promise<McpManager> {
  const dir = mkdtempSync(join(tmpdir(), 'web-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  // a developer's own keys must not leak into the "keyless" cases
  const full = { BRAVE_API_KEY: '', SEARXNG_URL: '', WEB_ALLOW_PRIVATE: '1', ...env }
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify({
      mcpServers: { web: { command: process.execPath, args: [SCRIPT], env: full } },
    }),
  )
  const m = new McpManager({
    configPath: join(dir, 'mcp.json'),
    permissions: { isAllowed: () => true, ask: async () => 'always', remember: () => {} },
    connectTimeoutMs: 15_000,
    callTimeoutMs: 20_000,
  })
  cleanup.push(() => m.stop())
  await m.start()
  return m
}

describe('web MCP server', () => {
  it('lists search and read_page', async () => {
    const f = await fake()
    cleanup.push(() => f.server.close())
    const m = await managerFor({})
    expect(m.listTools().map((t) => t.name)).toEqual(['mcp__web__search', 'mcp__web__read_page'])
  })

  it('searches with Brave, passing count, freshness, country and the key', async () => {
    const f = await fake()
    cleanup.push(() => f.server.close())
    const m = await managerFor({
      BRAVE_API_KEY: 'k-brave',
      BRAVE_API_URL: `${f.base}/brave`,
      WEB_SEARCH_COUNTRY: 'SE',
    })
    const r = await m.callTool('mcp__web__search', {
      query: 'soil law',
      count: 3,
      freshness: 'week',
      site: 'europa.eu',
    })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('(brave)')
    expect(r.output).toContain('1. A strong title')
    expect(r.output).toContain('https://europa.eu/one')
    expect(r.output).toContain('Desc x & more')
    expect(r.output).toContain('(2 days ago)')
    const req = f.requests[0]
    const q = new URL(req.url, f.base).searchParams
    expect(q.get('q')).toBe('site:europa.eu soil law')
    expect(q.get('count')).toBe('3')
    expect(q.get('freshness')).toBe('pw')
    expect(q.get('country')).toBe('SE')
    expect(req.key).toBe('k-brave')
  })

  it('falls back to the next backend when Brave fails, and says so', async () => {
    const f = await fake()
    cleanup.push(() => f.server.close())
    const m = await managerFor({
      BRAVE_API_KEY: 'k',
      BRAVE_API_URL: `${f.base}/brave-broken`,
      SEARXNG_URL: `${f.base}/searx`,
    })
    const r = await m.callTool('mcp__web__search', { query: 'x', freshness: 'month' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('(searxng)')
    expect(r.output).toContain('Searx hit')
    expect(r.output).toContain('brave: Brave 429: quota exceeded')
    const sx = f.requests.find((q) => q.url.startsWith('/searx'))
    expect(new URL(sx!.url, f.base).searchParams.get('time_range')).toBe('month')
  })

  it('parses DuckDuckGo results with snippets, skips ads, and reports a bot check', async () => {
    const f = await fake()
    cleanup.push(() => f.server.close())
    const m = await managerFor({ DDG_HTML_URL: `${f.base}/ddg/` })
    const r = await m.callTool('mcp__web__search', { query: 'soil' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('(duckduckgo)')
    expect(r.output).not.toContain('Sponsored')
    expect(r.output).toContain('1. Soil Monitoring Law')
    expect(r.output).toContain('https://europa.eu/soil')
    expect(r.output).toContain('The directive on soil & monitoring…')
    expect(r.output).toContain('2. Second result')

    // html endpoint bot-checked, lite endpoint answers → lite results with a note
    const m2 = await managerFor({
      DDG_HTML_URL: `${f.base}/ddg-challenge/`,
      DDG_LITE_URL: `${f.base}/lite/`,
    })
    const r2 = await m2.callTool('mcp__web__search', { query: 'soil' })
    expect(r2.isError).toBe(false)
    expect(r2.output).toContain('(duckduckgo-lite)')
    expect(r2.output).toContain('1. Lite one')
    expect(r2.output).toContain('https://lite.example/one')
    expect(r2.output).toContain('first lite snippet')
    expect(r2.output).toContain('duckduckgo: DuckDuckGo answered with a bot check')
    // both bot-checked → error
    const m3 = await managerFor({
      DDG_HTML_URL: `${f.base}/ddg-challenge/`,
      DDG_LITE_URL: `${f.base}/ddg-challenge/`,
    })
    const r3 = await m3.callTool('mcp__web__search', { query: 'soil' })
    expect(r3.isError).toBe(true)
    expect(r3.output).toContain('bot check')
  })

  it('reads a page as text, follows redirects, drops chrome, and chunks long pages', async () => {
    const f = await fake()
    cleanup.push(() => f.server.close())
    const m = await managerFor({})
    const r = await m.callTool('mcp__web__read_page', { url: `${f.base}/redirect`, max_chars: 500 })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('Title: Soil & Carbon')
    expect(r.output).toContain(`URL: ${f.base}/page`)
    expect(r.output).toContain('# Soil carbon')
    expect(r.output).toContain('First paragraph with bold text – and an entity: ä.')
    expect(r.output).toContain('- item one')
    expect(r.output).toContain('a | b |')
    expect(r.output).not.toContain('NAVLINK')
    expect(r.output).not.toContain('FOOTERTEXT')
    expect(r.output).not.toContain('SCRIPTTEXT')
    const more =
      /\[truncated: (\d+) more characters — call read_page again with offset=(\d+)\]/.exec(r.output)
    expect(more).toBeTruthy()
    const next = await m.callTool('mcp__web__read_page', {
      url: `${f.base}/page`,
      offset: Number(more![2]),
    })
    expect(next.output).toContain(`(from ${more![2]})`)
    expect(next.output).not.toContain('[truncated')

    const plain = await m.callTool('mcp__web__read_page', { url: `${f.base}/text` })
    expect(plain.output).toContain('just plain\n\ntext')
    const pdf = await m.callTool('mcp__web__read_page', { url: `${f.base}/pdf` })
    expect(pdf.isError).toBe(true)
    expect(pdf.output).toContain('PDF')
  })

  it('refuses private and loopback targets unless allowed', async () => {
    const f = await fake()
    cleanup.push(() => f.server.close())
    const m = await managerFor({ WEB_ALLOW_PRIVATE: '' })
    const r = await m.callTool('mcp__web__read_page', { url: `${f.base}/page` })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('private or local address')
    expect((await m.callTool('mcp__web__read_page', { url: 'ftp://example.org/x' })).isError).toBe(
      true,
    )
  })
})
