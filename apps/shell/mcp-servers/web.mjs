#!/usr/bin/env node
/**
 * Web search and page reading as an MCP server over stdio. Same shape as
 * nano-banana.mjs / veo.mjs: dependency-free, newline-delimited JSON-RPC, runs
 * on the app's own runtime or any Node.
 *
 * `search` tries the configured backends in order and answers with the first
 * that returns results:
 *   BRAVE_API_KEY   Brave Search API (api-dashboard.search.brave.com; the free
 *                   plan is enough for personal use)
 *   SEARXNG_URL     a SearXNG instance with the JSON format enabled
 *   (nothing)       DuckDuckGo's HTML endpoint, then its lite endpoint: keyless,
 *                   but each answers with a bot check instead of results now and then
 * `read_page` fetches a URL and returns its readable text (HTML → text; plain
 * text, Markdown and JSON pass through). Private and loopback addresses are
 * refused, including after redirects (WEB_ALLOW_PRIVATE=1 lifts that for tests).
 *
 * Environment:
 *   BRAVE_API_KEY, SEARXNG_URL        backends (see above)
 *   WEB_SEARCH_COUNTRY                e.g. SE — Brave `country`
 *   WEB_SEARCH_LANG                   e.g. sv — Brave `search_lang`, SearXNG `language`
 *   BRAVE_API_URL, DDG_HTML_URL, DDG_LITE_URL   endpoint overrides (tests)
 *   WEB_ALLOW_PRIVATE                 1 = allow private/loopback targets in read_page
 */
import { createInterface } from 'node:readline'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

const SERVER = { name: 'web', version: '1.0.0' }
const BRAVE_KEY = process.env.BRAVE_API_KEY || ''
const BRAVE_URL = process.env.BRAVE_API_URL || 'https://api.search.brave.com/res/v1/web/search'
const SEARXNG = (process.env.SEARXNG_URL || '').replace(/\/+$/, '')
const DDG_URL = process.env.DDG_HTML_URL || 'https://html.duckduckgo.com/html/'
const DDG_LITE_URL = process.env.DDG_LITE_URL || 'https://lite.duckduckgo.com/lite/'
const COUNTRY = process.env.WEB_SEARCH_COUNTRY || ''
const LANG = process.env.WEB_SEARCH_LANG || ''
const ALLOW_PRIVATE = process.env.WEB_ALLOW_PRIVATE === '1'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const FRESHNESS = ['day', 'week', 'month', 'year']
const MAX_PAGE_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5

const TOOLS = [
  {
    name: 'search',
    description:
      'Search the web for current information, references, data and facts. Returns titles, URLs and snippets. Read the promising results with read_page before quoting figures, and cite the source URL when you add information to a document, sheet or slide. Never invent numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (any language)' },
        count: { type: 'integer', description: '1–10 results, default 6' },
        freshness: {
          type: 'string',
          enum: FRESHNESS,
          description: 'Only results from the past day / week / month / year',
        },
        site: { type: 'string', description: 'Restrict to one domain, e.g. europa.eu' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_page',
    description:
      'Fetch a web page and return its readable text (HTML converted to plain text; plain text, Markdown and JSON pass through). Use it after search to get the actual content behind a result. Long pages come in chunks: call again with offset to continue. PDFs are not supported.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL' },
        max_chars: {
          type: 'integer',
          description: 'Characters per call, 500–40000, default 12000',
        },
        offset: { type: 'integer', description: 'Start position for the next chunk, default 0' },
      },
      required: ['url'],
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

// ── helpers ───────────────────────────────────────────────

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 20_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  auml: 'ä',
  ouml: 'ö',
  aring: 'å',
  Auml: 'Ä',
  Ouml: 'Ö',
  Aring: 'Å',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  szlig: 'ß',
  oslash: 'ø',
  aelig: 'æ',
  euro: '€',
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name] ?? m)
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

function collapse(text) {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Readable text out of an HTML document: main/article when present, chrome regions dropped */
function htmlToText(html) {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas)\b[\s\S]*?<\/\1>/gi, '')
  const region =
    /<main\b[\s\S]*?<\/main>/i.exec(s)?.[0] ?? /<article\b[\s\S]*?<\/article>/i.exec(s)?.[0]
  if (region && region.length > 500) s = region
  else s = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(s)?.[1] ?? s
  s = s
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(h[1-6])\b[^>]*>/gi, (_, h) => '\n\n' + '#'.repeat(Number(h[1])) + ' ')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(
      /<\/(p|div|section|article|blockquote|pre|tr|table|ul|ol|dl|figure|figcaption)>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, '')
  return { title, text: collapse(decodeEntities(s)) }
}

// ── search backends ───────────────────────────────────────

function formatResults(query, method, results, note) {
  const lines = [`Results for "${query}" (${method}):`]
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`, `   ${r.url}`)
    if (r.snippet) lines.push(`   ${r.snippet}`)
    if (r.age) lines.push(`   (${r.age})`)
  })
  if (note) lines.push('', note)
  lines.push(
    '',
    'Use read_page on a result to get its full text before quoting facts, and cite the URL when adding information to the document.',
  )
  return lines.join('\n')
}

async function braveSearch(query, count, freshness) {
  const u = new URL(BRAVE_URL)
  u.searchParams.set('q', query)
  u.searchParams.set('count', String(count))
  if (freshness)
    u.searchParams.set('freshness', { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[freshness])
  if (COUNTRY) u.searchParams.set('country', COUNTRY)
  if (LANG) u.searchParams.set('search_lang', LANG)
  const res = await fetchWithTimeout(u, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': BRAVE_KEY },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok)
    throw new Error(
      `Brave ${res.status}: ${json?.message || json?.error?.detail || res.statusText}`,
    )
  return (json.web?.results ?? []).slice(0, count).map((r) => ({
    title: stripTags(String(r.title ?? '')),
    url: String(r.url ?? ''),
    snippet: stripTags(String(r.description ?? '')),
    age: r.age || r.page_age || '',
  }))
}

async function searxngSearch(query, count, freshness) {
  const u = new URL(`${SEARXNG}/search`)
  u.searchParams.set('q', query)
  u.searchParams.set('format', 'json')
  if (freshness) u.searchParams.set('time_range', freshness)
  if (LANG) u.searchParams.set('language', LANG)
  const res = await fetchWithTimeout(u, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`SearXNG ${res.status}: ${res.statusText}`)
  const json = await res.json().catch(() => ({}))
  return (json.results ?? []).slice(0, count).map((r) => ({
    title: stripTags(String(r.title ?? '')),
    url: String(r.url ?? ''),
    snippet: stripTags(String(r.content ?? '')),
    age: r.publishedDate || '',
  }))
}

function decodeDuckUrl(href) {
  const m = /[?&]uddg=([^&]+)/.exec(href)
  if (m) return decodeURIComponent(m[1])
  return href.startsWith('http') ? href : ''
}

async function ddgSearch(query, count) {
  const u = new URL(DDG_URL)
  u.searchParams.set('q', query)
  const res = await fetchWithTimeout(u, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  })
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}: ${res.statusText}`)
  const html = await res.text()
  const results = []
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const anchors = []
  let m
  while ((m = re.exec(html)) !== null)
    anchors.push({ index: m.index, end: m.index + m[0].length, href: m[1], title: m[2] })
  for (let i = 0; i < anchors.length && results.length < count; i++) {
    const a = anchors[i]
    // an ad block wraps its own result__a: skip it
    const before = html.slice(Math.max(0, a.index - 400), a.index)
    if (/result--ad/.test(before) && !/result__a/.test(before)) continue
    const segment = html.slice(a.end, anchors[i + 1]?.index ?? html.length)
    const snip = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(segment)
    const url = decodeDuckUrl(a.href)
    const title = stripTags(a.title)
    if (url && title) results.push({ title, url, snippet: snip ? stripTags(snip[1]) : '', age: '' })
  }
  if (!anchors.length && /anomaly|challenge/i.test(html)) {
    throw new Error(
      'DuckDuckGo answered with a bot check instead of results. Try again in a moment, or set BRAVE_API_KEY for a reliable backend.',
    )
  }
  return results
}

/** DuckDuckGo's lite endpoint: a different frontend that often answers when the html one serves a bot check */
async function ddgLiteSearch(query, count) {
  const u = new URL(DDG_LITE_URL)
  u.searchParams.set('q', query)
  const res = await fetchWithTimeout(u, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  })
  if (!res.ok) throw new Error(`DuckDuckGo lite ${res.status}: ${res.statusText}`)
  const html = await res.text()
  // attribute order and quote style vary (rel/href/class, single or double quotes)
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
    .filter((m) => /class=['"]result-link['"]/.test(m[1]))
    .map((m) => ({ href: /href=['"]([^'"]+)['"]/.exec(m[1])?.[1] ?? '', title: m[2] }))
  const snippets = [...html.matchAll(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)]
  const results = []
  links.forEach((l, i) => {
    if (results.length >= count) return
    const url = decodeDuckUrl(l.href.startsWith('//') ? `https:${l.href}` : l.href)
    const title = stripTags(l.title)
    if (url && title)
      results.push({ title, url, snippet: snippets[i] ? stripTags(snippets[i][1]) : '', age: '' })
  })
  if (!links.length && /anomaly|challenge/i.test(html)) {
    throw new Error('DuckDuckGo lite answered with a bot check as well')
  }
  return results
}

async function search(args) {
  let query = String(args.query ?? '').trim()
  if (!query) return textResult('query must not be empty', true)
  const site = String(args.site ?? '').trim()
  if (site && !/\s/.test(site)) query = `site:${site} ${query}`
  const count = clamp(Number(args.count) || 6, 1, 10)
  const freshness = FRESHNESS.includes(args.freshness) ? args.freshness : ''
  const backends = []
  if (BRAVE_KEY) backends.push(['brave', () => braveSearch(query, count, freshness)])
  if (SEARXNG) backends.push(['searxng', () => searxngSearch(query, count, freshness)])
  backends.push(['duckduckgo', () => ddgSearch(query, count)])
  backends.push(['duckduckgo-lite', () => ddgLiteSearch(query, count)])
  const failures = []
  for (const [name, run] of backends) {
    try {
      const results = await run()
      if (results.length) {
        const note = failures.length
          ? `(${failures.join('; ')} — showing ${name} results instead)`
          : ''
        return textResult(formatResults(query, name, results, note))
      }
      failures.push(`${name}: no results`)
    } catch (err) {
      failures.push(`${name}: ${String(err?.message ?? err)}`)
    }
  }
  return textResult(`Web search failed: ${failures.join('; ')}`, true)
}

// ── page reading ──────────────────────────────────────────

const PRIVATE = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
])
  PRIVATE.addSubnet(net, bits, 'ipv4')
PRIVATE.addSubnet('::1', 128, 'ipv6')
PRIVATE.addSubnet('fc00::', 7, 'ipv6')
PRIVATE.addSubnet('fe80::', 10, 'ipv6')

function isPrivateAddress(addr) {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr)?.[1]
  if (v4) return PRIVATE.check(v4, 'ipv4')
  const fam = isIP(addr)
  return fam === 4 ? PRIVATE.check(addr, 'ipv4') : fam === 6 ? PRIVATE.check(addr, 'ipv6') : true
}

async function assertPublic(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('only http(s) URLs can be read')
  if (ALLOW_PRIVATE) return
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addrs = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address)
  if (!addrs.length) throw new Error(`could not resolve ${host}`)
  if (addrs.some(isPrivateAddress))
    throw new Error(`${host} points at a private or local address; refusing to read it`)
}

async function fetchGuarded(start) {
  let url = new URL(start)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url)
    const res = await fetchWithTimeout(url, {
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
    })
    const location = res.headers.get('location')
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      await res.arrayBuffer().catch(() => {})
      url = new URL(location, url)
      continue
    }
    return { res, finalUrl: url.toString() }
  }
  throw new Error('too many redirects')
}

async function readPage(args) {
  const url = String(args.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) return textResult('url must be an http(s) URL', true)
  const maxChars = clamp(Number(args.max_chars) || 12_000, 500, 40_000)
  const offset = Math.max(0, Number(args.offset) || 0)
  const { res, finalUrl } = await fetchGuarded(url)
  if (!res.ok) return textResult(`Could not read the page (HTTP ${res.status})`, true)
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > MAX_PAGE_BYTES)
    return textResult(`The page is too large to read (${Math.round(declared / 1048576)} MB)`, true)
  const bytes = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_PAGE_BYTES)
  if (type === 'application/pdf' || bytes.subarray(0, 5).toString() === '%PDF-') {
    return textResult(
      'The link is a PDF; read_page handles HTML and text only. Give the user the link (or suggest opening it in DuneOffice PDF).',
      true,
    )
  }
  const body = bytes.toString('utf8')
  let title = ''
  let text
  if (type.includes('html') || (!type && /<html|<body|<div/i.test(body))) {
    ;({ title, text } = htmlToText(body))
  } else if (type.startsWith('text/') || type.includes('json') || type.includes('xml')) {
    text = collapse(body)
  } else {
    return textResult(`Unsupported content type: ${type || 'unknown'}`, true)
  }
  const total = text.length
  const chunk = text.slice(offset, offset + maxChars)
  const header = `Title: ${title || '(none)'}\nURL: ${finalUrl}\nLength: ${total} characters${offset ? ` (from ${offset})` : ''}\n\n`
  const rest = total - (offset + chunk.length)
  const footer =
    rest > 0
      ? `\n\n[truncated: ${rest} more characters — call read_page again with offset=${offset + chunk.length}]`
      : ''
  return textResult(header + chunk + footer)
}

async function callTool(name, args) {
  if (name === 'search') return search(args)
  if (name === 'read_page') return readPage(args)
  return textResult(`Unknown tool: ${name}`, true)
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
