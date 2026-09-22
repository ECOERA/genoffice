/**
 * Citations — a hosted MCP server (see mcp-host.ts) that resolves a DOI, a
 * URL or a title to bibliographic metadata (Crossref, then OpenAlex; page
 * metadata for web sources) and formats references in APA 7, Harvard,
 * Vancouver or IEEE with the matching in-text form. Dependency-free; the
 * page fetcher is injected so the shell can pass its SSRF-guarded fetch.
 */
import { textResult, type HostedServer, type HostedTool } from '../mcp-host'

export interface CiteOptions {
  /** fetches a web page's HTML (null when blocked or unreachable) */
  fetchText: (url: string) => Promise<string | null>
  crossrefBase?: string
  openalexBase?: string
  /** contact for the polite pools (Crossref/OpenAlex ask for one) */
  mailto?: string
  timeoutMs?: number
}

export interface Author {
  family: string
  given?: string
}

export interface Reference {
  type: 'article' | 'book' | 'chapter' | 'report' | 'web' | 'other'
  title: string
  authors: Author[]
  year?: number
  container?: string
  volume?: string
  issue?: string
  pages?: string
  publisher?: string
  doi?: string
  url?: string
  accessed?: string
  /** where the metadata came from */
  source: 'crossref' | 'openalex' | 'page' | 'input'
}

export type CiteStyle = 'apa' | 'harvard' | 'vancouver' | 'ieee'
const STYLES: CiteStyle[] = ['apa', 'harvard', 'vancouver', 'ieee']
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "Jane Q. Public" → { family: Public, given: Jane Q. }; "Public, Jane" handled too */
const ORG_RE =
  /\b(AB|Ltd|Inc|LLC|GmbH|Commission|Agency|Institute|University|Organi[sz]ation|Ministry|Department|Council|Board|Foundation|Association|Group|Programme|Program|Verket|Myndigheten?|Kommun|Region|Centre|Center|Bank|Office|Society|Union|Network)\b/i

export function parseName(name: string): Author {
  const n = name.replace(/\s+/g, ' ').trim()
  if (!n) return { family: '' }
  // organisations are cited whole, never split into given/family
  if (ORG_RE.test(n) && !n.includes(',')) return { family: n }
  if (n.includes(',')) {
    const [family, given] = n.split(',', 2)
    return { family: family!.trim(), given: given?.trim() || undefined }
  }
  const parts = n.split(' ')
  if (parts.length === 1) return { family: n }
  const family = parts.pop()!
  return { family, given: parts.join(' ') }
}

function initials(given: string | undefined, sep = '. ', trailingDot = true): string {
  if (!given) return ''
  const parts = given.split(/[\s.-]+/).filter(Boolean)
  const s = parts.map((p) => p[0]!.toUpperCase()).join(sep)
  return trailingDot ? `${s}.` : s
}

function cleanDoi(doi: string): string {
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim()
}

function yearFrom(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const m = /(\d{4})/.exec(v)
    if (m) return Number(m[1])
  }
  return undefined
}

// ── Crossref / OpenAlex ─────────────────────────────────

type Json = Record<string, unknown>
const asRecord = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function fromCrossref(item: Json): Reference {
  const kind = String(item.type ?? '')
  const type: Reference['type'] =
    kind === 'journal-article'
      ? 'article'
      : kind === 'book' || kind === 'monograph'
        ? 'book'
        : kind === 'book-chapter'
          ? 'chapter'
          : kind === 'report' || kind === 'posted-content'
            ? 'report'
            : 'other'
  const dateParts = asArray(
    asRecord(item.issued ?? item['published-print'] ?? item['published-online'])['date-parts'],
  )
  const year = yearFrom(asArray(dateParts[0])[0])
  const authors = asArray(item.author).map((a) => {
    const r = asRecord(a)
    return r.family
      ? { family: String(r.family), given: r.given ? String(r.given) : undefined }
      : parseName(String(r.name ?? ''))
  })
  const doi = item.DOI ? cleanDoi(String(item.DOI)) : undefined
  return {
    type,
    title: decode(String(asArray(item.title)[0] ?? item.title ?? '')),
    authors,
    year,
    container: decode(String(asArray(item['container-title'])[0] ?? '')) || undefined,
    volume: item.volume ? String(item.volume) : undefined,
    issue: item.issue ? String(item.issue) : undefined,
    pages: item.page ? String(item.page) : undefined,
    publisher: item.publisher ? String(item.publisher) : undefined,
    doi,
    url: doi ? `https://doi.org/${doi}` : item.URL ? String(item.URL) : undefined,
    source: 'crossref',
  }
}

function fromOpenAlex(item: Json): Reference {
  const kind = String(item.type ?? '')
  const type: Reference['type'] =
    kind === 'article'
      ? 'article'
      : kind === 'book'
        ? 'book'
        : kind === 'book-chapter'
          ? 'chapter'
          : kind === 'report'
            ? 'report'
            : 'other'
  const loc = asRecord(item.primary_location)
  const src = asRecord(loc.source)
  const biblio = asRecord(item.biblio)
  const doi = item.doi ? cleanDoi(String(item.doi)) : undefined
  const pages =
    biblio.first_page && biblio.last_page
      ? `${biblio.first_page}-${biblio.last_page}`
      : biblio.first_page
        ? String(biblio.first_page)
        : undefined
  return {
    type,
    title: decode(String(item.display_name ?? item.title ?? '')),
    authors: asArray(item.authorships).map((a) =>
      parseName(String(asRecord(asRecord(a).author).display_name ?? '')),
    ),
    year: yearFrom(item.publication_year),
    container: src.display_name ? String(src.display_name) : undefined,
    volume: biblio.volume ? String(biblio.volume) : undefined,
    issue: biblio.issue ? String(biblio.issue) : undefined,
    pages,
    doi,
    url: doi
      ? `https://doi.org/${doi}`
      : loc.landing_page_url
        ? String(loc.landing_page_url)
        : undefined,
    source: 'openalex',
  }
}

// ── web page metadata ───────────────────────────────────

function metaAll(html: string, key: string): string[] {
  const out: string[] = []
  const re = /<meta\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const tag = m[0]
    const name = /\b(?:name|property|itemprop)\s*=\s*["']([^"']+)["']/i
      .exec(tag)?.[1]
      ?.toLowerCase()
    if (name !== key.toLowerCase()) continue
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (content) out.push(decode(content))
  }
  return out
}
const meta = (html: string, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = metaAll(html, k)[0]
    if (v) return v
  }
  return undefined
}

export function referenceFromPage(url: string, html: string): Reference {
  let ld: Json = {}
  const ldMatch =
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)
  if (ldMatch) {
    try {
      const parsed = JSON.parse(ldMatch[1]!) as unknown
      const first = Array.isArray(parsed) ? parsed[0] : parsed
      const graph = asArray(asRecord(first)['@graph'])
      ld = asRecord(
        graph.find((g) => /Article|Report|WebPage/i.test(String(asRecord(g)['@type']))) ?? first,
      )
    } catch {
      /* ignore broken JSON-LD */
    }
  }
  const title =
    meta(html, 'citation_title', 'dc.title', 'og:title') ??
    (ld.headline ? String(ld.headline) : undefined) ??
    decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
  const authorNames = [
    ...metaAll(html, 'citation_author'),
    ...metaAll(html, 'dc.creator'),
    ...metaAll(html, 'author'),
    ...asArray(ld.author ?? []).map((a) =>
      String(asRecord(a).name ?? (typeof a === 'string' ? a : '')),
    ),
    ...(ld.author && !Array.isArray(ld.author) ? [String(asRecord(ld.author).name ?? '')] : []),
  ].filter(Boolean)
  const seen = new Set<string>()
  const authors = authorNames
    .filter((n) => (seen.has(n) ? false : (seen.add(n), true)))
    .map(parseName)
  const date =
    meta(
      html,
      'citation_publication_date',
      'citation_date',
      'article:published_time',
      'dc.date',
      'dcterms.date',
      'date',
    ) ?? (ld.datePublished ? String(ld.datePublished) : undefined)
  const site =
    meta(html, 'og:site_name', 'citation_journal_title', 'citation_publisher', 'dc.publisher') ??
    (ld.publisher ? String(asRecord(ld.publisher).name ?? '') : undefined) ??
    new URL(url).hostname.replace(/^www\./, '')
  const doi = meta(html, 'citation_doi', 'dc.identifier')?.match(DOI_RE)?.[1]
  return {
    type: 'web',
    title,
    authors,
    year: yearFrom(date),
    container: site || undefined,
    doi: doi ? cleanDoi(doi) : undefined,
    url,
    accessed: new Date().toISOString().slice(0, 10),
    source: 'page',
  }
}

// ── formatting ──────────────────────────────────────────

function joinNames(names: string[], and: string, serialComma: boolean): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]}${and}${names[1]}`
  return `${names.slice(0, -1).join(', ')}${serialComma ? ',' : ''}${and}${names.at(-1)}`
}

function apaAuthors(a: Author[]): string {
  const names = a.map((x) => (x.given ? `${x.family}, ${initials(x.given)}` : x.family))
  if (names.length > 20) return `${names.slice(0, 19).join(', ')}, … ${names.at(-1)}`
  return joinNames(names, ' & ', true)
}

function harvardAuthors(a: Author[]): string {
  return joinNames(
    a.map((x) =>
      x.given ? `${x.family}, ${initials(x.given, '.', true).replace(/\.\s*/g, '.')}` : x.family,
    ),
    ' and ',
    false,
  )
}

function vancouverAuthors(a: Author[]): string {
  const names = a.slice(0, 6).map((x) => `${x.family} ${initials(x.given, '', false)}`.trim())
  return names.join(', ') + (a.length > 6 ? ', et al' : '')
}

function ieeeAuthors(a: Author[]): string {
  const names = a.map((x) => `${initials(x.given)} ${x.family}`.trim())
  if (names.length > 6) return `${names[0]} et al.`
  return joinNames(names, ' and ', true)
}

const yearOr = (r: Reference) => (r.year ? String(r.year) : 'n.d.')

export function formatReference(r: Reference, style: CiteStyle): string {
  const doiOrUrl = r.doi ? `https://doi.org/${r.doi}` : (r.url ?? '')
  const vol = r.volume ? r.volume : ''
  const iss = r.issue ? `(${r.issue})` : ''
  switch (style) {
    case 'apa': {
      const who = r.authors.length ? apaAuthors(r.authors) : (r.container ?? '')
      const head = `${who} (${yearOr(r)}).`
      if (r.type === 'article') {
        const where = [r.container, vol ? `${vol}${iss}` : '', r.pages ?? '']
          .filter(Boolean)
          .join(', ')
        return `${head} ${r.title}. ${where}${where ? '.' : ''} ${doiOrUrl}`
          .replace(/\s+/g, ' ')
          .trim()
      }
      if (r.type === 'web') {
        const site = r.authors.length && r.container ? ` ${r.container}.` : ''
        return `${head} ${r.title}.${site} ${r.accessed ? `Retrieved ${r.accessed}, from ` : ''}${r.url ?? ''}`.trim()
      }
      const pub = r.publisher ? ` ${r.publisher}.` : ''
      const inBook =
        r.type === 'chapter' && r.container
          ? ` In ${r.container}${r.pages ? ` (pp. ${r.pages})` : ''}.`
          : ''
      return `${head} ${r.title}.${inBook}${pub} ${doiOrUrl}`.trim()
    }
    case 'harvard': {
      const who = r.authors.length ? harvardAuthors(r.authors) : (r.container ?? '')
      if (r.type === 'article') {
        const where = [r.container, vol ? `${vol}${iss}` : '', r.pages ? `pp. ${r.pages}` : '']
          .filter(Boolean)
          .join(', ')
        return `${who} (${yearOr(r)}) '${r.title}', ${where}. ${r.doi ? `doi:${r.doi}` : (r.url ?? '')}`
          .replace(/\s+/g, ' ')
          .trim()
      }
      if (r.type === 'web') {
        return `${who} (${yearOr(r)}) ${r.title}. Available at: ${r.url ?? ''}${r.accessed ? ` (Accessed: ${r.accessed})` : ''}.`
      }
      return `${who} (${yearOr(r)}) ${r.title}.${r.publisher ? ` ${r.publisher}.` : ''} ${doiOrUrl}`.trim()
    }
    case 'vancouver': {
      const who = r.authors.length ? `${vancouverAuthors(r.authors)}.` : ''
      if (r.type === 'article') {
        const where = `${r.container ?? ''}. ${yearOr(r)}${vol ? `;${vol}${iss}` : ''}${r.pages ? `:${r.pages}` : ''}.`
        return `${who} ${r.title}. ${where} ${r.doi ? `doi:${r.doi}` : (r.url ?? '')}`
          .replace(/\s+/g, ' ')
          .trim()
      }
      if (r.type === 'web') {
        return `${who} ${r.title} [Internet]. ${r.container ?? ''}; ${yearOr(r)} [cited ${r.accessed ?? ''}]. Available from: ${r.url ?? ''}`
          .replace(/\s+/g, ' ')
          .trim()
      }
      return `${who} ${r.title}. ${r.publisher ? `${r.publisher}; ` : ''}${yearOr(r)}. ${doiOrUrl}`
        .replace(/\s+/g, ' ')
        .trim()
    }
    case 'ieee': {
      const who = r.authors.length ? `${ieeeAuthors(r.authors)}, ` : ''
      if (r.type === 'article') {
        const where = [
          r.container,
          vol ? `vol. ${vol}` : '',
          r.issue ? `no. ${r.issue}` : '',
          r.pages ? `pp. ${r.pages}` : '',
          yearOr(r),
        ]
          .filter(Boolean)
          .join(', ')
        return `${who}"${r.title}," ${where}${r.doi ? `, doi: ${r.doi}` : ''}.`
      }
      if (r.type === 'web') {
        return `${who}"${r.title}," ${r.container ?? ''}. ${r.url ?? ''} (accessed ${r.accessed ?? ''}).`
      }
      return `${who}${r.title}. ${r.publisher ? `${r.publisher}, ` : ''}${yearOr(r)}. ${doiOrUrl}`.trim()
    }
  }
}

export function inText(r: Reference, style: CiteStyle, n: number): string {
  if (style === 'vancouver' || style === 'ieee') return `[${n}]`
  const fam = r.authors.map((a) => a.family)
  const who =
    fam.length === 0
      ? (r.container ?? r.title)
      : fam.length === 1
        ? fam[0]!
        : fam.length === 2
          ? `${fam[0]} ${style === 'apa' ? '&' : 'and'} ${fam[1]}`
          : `${fam[0]} et al.`
  return style === 'apa' ? `(${who}, ${yearOr(r)})` : `(${who} ${yearOr(r)})`
}

// ── resolver ────────────────────────────────────────────

export class Citer {
  private readonly crossref: string
  private readonly openalex: string
  constructor(private readonly opts: CiteOptions) {
    this.crossref = (opts.crossrefBase ?? 'https://api.crossref.org').replace(/\/+$/, '')
    this.openalex = (opts.openalexBase ?? 'https://api.openalex.org').replace(/\/+$/, '')
  }

  private async json(url: string): Promise<Json | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15_000)
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (this.opts.mailto) headers['User-Agent'] = `DuneOffice (mailto:${this.opts.mailto})`
      const res = await fetch(url, { headers, signal: controller.signal })
      if (!res.ok) return null
      return asRecord(await res.json())
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async byDoi(doi: string): Promise<Reference | null> {
    const clean = cleanDoi(doi)
    const cr = await this.json(`${this.crossref}/works/${encodeURIComponent(clean)}`)
    if (cr) return fromCrossref(asRecord(cr.message))
    const oa = await this.json(
      `${this.openalex}/works/https://doi.org/${encodeURIComponent(clean)}`,
    )
    return oa ? fromOpenAlex(oa) : null
  }

  async byQuery(query: string, limit: number): Promise<Reference[]> {
    const cr = await this.json(
      `${this.crossref}/works?query.bibliographic=${encodeURIComponent(query)}&rows=${limit}${this.opts.mailto ? `&mailto=${encodeURIComponent(this.opts.mailto)}` : ''}`,
    )
    const items = asArray(asRecord(cr?.message).items).map((i) => fromCrossref(asRecord(i)))
    if (items.length) return items
    const oa = await this.json(
      `${this.openalex}/works?search=${encodeURIComponent(query)}&per-page=${limit}`,
    )
    return asArray(oa?.results).map((i) => fromOpenAlex(asRecord(i)))
  }

  async byUrl(url: string): Promise<Reference | null> {
    const html = await this.opts.fetchText(url)
    if (html == null) return null
    const page = referenceFromPage(url, html)
    if (page.doi) {
      const full = await this.byDoi(page.doi)
      if (full) return { ...full, url: full.url ?? url }
    }
    return page
  }

  /** a DOI, a URL, a title, or ready metadata → references (several when a title is ambiguous) */
  async resolve(input: unknown, limit = 5): Promise<Reference[]> {
    if (input && typeof input === 'object') {
      const r = input as Json
      if (typeof r.doi === 'string' && r.doi && !r.title)
        return [await this.byDoi(r.doi)].filter((x): x is Reference => !!x)
      if (typeof r.url === 'string' && r.url && !r.title)
        return [await this.byUrl(r.url)].filter((x): x is Reference => !!x)
      if (typeof r.title === 'string' && r.title) {
        const authors = asArray(r.authors).map((a) =>
          typeof a === 'string'
            ? parseName(a)
            : asRecord(a).family
              ? {
                  family: String(asRecord(a).family),
                  given: asRecord(a).given ? String(asRecord(a).given) : undefined,
                }
              : parseName(String(asRecord(a).name ?? '')),
        )
        return [
          {
            type: (['article', 'book', 'chapter', 'report', 'web', 'other'] as const).includes(
              r.type as never,
            )
              ? (r.type as Reference['type'])
              : r.container
                ? 'article'
                : 'other',
            title: String(r.title),
            authors,
            year: yearFrom(r.year),
            container: r.container ? String(r.container) : undefined,
            volume: r.volume ? String(r.volume) : undefined,
            issue: r.issue ? String(r.issue) : undefined,
            pages: r.pages ? String(r.pages) : undefined,
            publisher: r.publisher ? String(r.publisher) : undefined,
            doi: r.doi ? cleanDoi(String(r.doi)) : undefined,
            url: r.url ? String(r.url) : undefined,
            accessed: r.accessed ? String(r.accessed) : undefined,
            source: 'input',
          },
        ]
      }
      if (typeof r.query === 'string') return this.resolve(r.query, limit)
      return []
    }
    const text = String(input ?? '').trim()
    if (!text) return []
    const doi = DOI_RE.exec(text)?.[1]
    if (doi && (text.length < 120 || /doi\.org/i.test(text))) {
      const r = await this.byDoi(doi)
      if (r) return [r]
    }
    if (/^https?:\/\//i.test(text)) {
      const r = await this.byUrl(text)
      return r ? [r] : []
    }
    return this.byQuery(text, limit)
  }
}

function describe(r: Reference): string {
  const who = r.authors.length
    ? r.authors
        .map((a) => a.family)
        .slice(0, 3)
        .join(', ') + (r.authors.length > 3 ? ' et al.' : '')
    : '(no author)'
  return `${who} (${yearOr(r)}). ${r.title}${r.container ? `. ${r.container}` : ''}${r.doi ? ` — doi:${r.doi}` : r.url ? ` — ${r.url}` : ''} [${r.source}]`
}

export function createCiteServer(citer: Citer): HostedServer {
  const tools: HostedTool[] = [
    {
      name: 'cite_lookup',
      description:
        'Find bibliographic metadata for a source: give a DOI, a URL, or a title/author words. Returns candidates with authors, year, container and DOI so you can confirm the right one, then format it with cite_format. Use it before quoting a paper or report.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'DOI (10.xxxx/…), URL, or title and author words' },
          limit: { type: 'integer', description: '1–10 candidates for title searches, default 5' },
        },
        required: ['query'],
      },
      run: async (args) => {
        const query = String(args.query ?? '').trim()
        if (!query) return textResult('query must not be empty', true)
        const refs = await citer.resolve(query, clamp(Number(args.limit) || 5, 1, 10))
        if (!refs.length) return textResult(`No metadata found for "${query}".`, true)
        const lines = [`Candidates for "${query}":`]
        refs.forEach((r, i) => lines.push(`${i + 1}. ${describe(r)}`))
        lines.push('', 'Pass the DOI (or the URL) to cite_format with the wanted style.')
        return lines.join('\n')
      },
    },
    {
      name: 'cite_format',
      description:
        'Format references in APA 7, Harvard, Vancouver or IEEE, with the in-text form to use in the sentence. Each item is a DOI, a URL, a title query, or full metadata {title, authors, year, container, volume, issue, pages, publisher, doi, url}. Web pages get an access date.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { type: ['string', 'object'] },
            description: 'DOIs, URLs, title queries, or metadata objects',
          },
          style: { type: 'string', enum: STYLES, description: 'default apa' },
          start: { type: 'integer', description: 'First number for numeric styles, default 1' },
        },
        required: ['items'],
      },
      run: async (args) => {
        const items = Array.isArray(args.items) ? args.items : [args.items]
        const style: CiteStyle = STYLES.includes(args.style as CiteStyle)
          ? (args.style as CiteStyle)
          : 'apa'
        const start = Math.max(1, Number(args.start) || 1)
        const refs: string[] = []
        const missing: string[] = []
        const numbered = style === 'vancouver' || style === 'ieee'
        let n = start
        for (const item of items) {
          const [ref] = await citer.resolve(item, 1)
          if (!ref) {
            missing.push(typeof item === 'string' ? item : JSON.stringify(item))
            continue
          }
          refs.push(
            `${numbered ? `[${n}] ` : ''}${formatReference(ref, style)}`,
            `   In-text: ${inText(ref, style, n)}`,
          )
          n++
        }
        if (!refs.length)
          return textResult(`Nothing could be resolved: ${missing.join('; ')}`, true)
        const head = `References (${{ apa: 'APA 7', harvard: 'Harvard', vancouver: 'Vancouver', ieee: 'IEEE' }[style]}):`
        const tail = missing.length ? `\n\nNot found: ${missing.join('; ')}` : ''
        return `${head}\n${refs.join('\n')}${tail}`
      },
    },
  ]
  return { name: 'cite', version: '1.0.0', tools }
}
