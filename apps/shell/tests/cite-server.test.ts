import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  Citer,
  createCiteServer,
  formatReference,
  inText,
  parseName,
  referenceFromPage,
  type Reference,
} from '../src/main/hosted/cite'

/** Citations: Crossref/OpenAlex lookups against a fake API, page metadata, four styles. */

const CROSSREF_ITEM = {
  DOI: '10.1000/soil.2024.1',
  type: 'journal-article',
  title: ['Soil carbon &amp; MRV'],
  author: [
    { given: 'Anna', family: 'Andersson' },
    { given: 'Bo Erik', family: 'Berg' },
    { given: 'Cecilia', family: 'Carlsson' },
  ],
  issued: { 'date-parts': [[2024, 5, 1]] },
  'container-title': ['Journal of Soil Science'],
  volume: '12',
  issue: '3',
  page: '45-67',
  publisher: 'Soil Press',
}

const PAGE_HTML = `<html><head>
<title>Fallback title</title>
<meta property="og:title" content="Soil Monitoring Law explained">
<meta property="og:site_name" content="European Commission">
<meta name="author" content="Jane Q. Public">
<meta property="article:published_time" content="2025-12-16T10:00:00Z">
</head><body></body></html>`

let server: Server | null = null
let base = ''
const requests: string[] = []
afterEach(() => {
  server?.close()
  server = null
  requests.length = 0
})

function fakeApi(): Promise<string> {
  server = createServer((req, res) => {
    const url = req.url ?? ''
    requests.push(url)
    res.setHeader('content-type', 'application/json')
    if (url.startsWith('/crossref/works/')) {
      if (decodeURIComponent(url.slice('/crossref/works/'.length)) === '10.1000/soil.2024.1') {
        res.end(JSON.stringify({ message: CROSSREF_ITEM }))
      } else res.writeHead(404).end()
      return
    }
    if (url.startsWith('/crossref/works?')) {
      const q = new URL(url, 'http://x').searchParams.get('query.bibliographic') ?? ''
      res.end(JSON.stringify({ message: { items: q.includes('nothing') ? [] : [CROSSREF_ITEM] } }))
      return
    }
    if (url.startsWith('/openalex/works?')) {
      res.end(
        JSON.stringify({
          results: [
            {
              display_name: 'An OpenAlex hit',
              type: 'article',
              publication_year: 2023,
              doi: 'https://doi.org/10.2000/oa.1',
              authorships: [{ author: { display_name: 'Dana Dahl' } }],
              primary_location: { source: { display_name: 'Open Journal' } },
              biblio: { volume: '2', issue: '1', first_page: '1', last_page: '9' },
            },
          ],
        }),
      )
      return
    }
    res.writeHead(404).end()
  })
  return new Promise((r) =>
    server!.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`
      r(base)
    }),
  )
}

function citer(): Citer {
  return new Citer({
    fetchText: async (url) => (url.includes('europa.eu') ? PAGE_HTML : null),
    crossrefBase: `${base}/crossref`,
    openalexBase: `${base}/openalex`,
  })
}

describe('Citer', () => {
  it('resolves a DOI through Crossref and normalises it', async () => {
    await fakeApi()
    const [r] = await citer().resolve('https://doi.org/10.1000/soil.2024.1')
    expect(r).toMatchObject({
      type: 'article',
      title: 'Soil carbon & MRV',
      year: 2024,
      container: 'Journal of Soil Science',
      volume: '12',
      issue: '3',
      pages: '45-67',
      doi: '10.1000/soil.2024.1',
      url: 'https://doi.org/10.1000/soil.2024.1',
      source: 'crossref',
    })
    expect(r!.authors).toHaveLength(3)
    expect(requests[0]).toBe('/crossref/works/10.1000%2Fsoil.2024.1')
  })

  it('searches by title (Crossref first, OpenAlex when Crossref is empty)', async () => {
    await fakeApi()
    const c = citer()
    expect((await c.resolve('soil carbon MRV Andersson', 3))[0]?.doi).toBe('10.1000/soil.2024.1')
    const [oa] = await c.resolve('nothing here', 3)
    expect(oa).toMatchObject({
      title: 'An OpenAlex hit',
      year: 2023,
      doi: '10.2000/oa.1',
      pages: '1-9',
      source: 'openalex',
    })
    expect(oa!.authors[0]).toEqual({ family: 'Dahl', given: 'Dana' })
  })

  it('reads web page metadata', async () => {
    await fakeApi()
    const [r] = await citer().resolve('https://environment.ec.europa.eu/soil')
    expect(r).toMatchObject({
      type: 'web',
      title: 'Soil Monitoring Law explained',
      container: 'European Commission',
      year: 2025,
      url: 'https://environment.ec.europa.eu/soil',
      source: 'page',
    })
    expect(r!.authors[0]).toEqual({ family: 'Public', given: 'Jane Q.' })
    expect(r!.accessed).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(await citer().resolve('https://blocked.example/x')).toEqual([])
  })

  it('parses names and page metadata helpers', () => {
    expect(parseName('Public, Jane Q.')).toEqual({ family: 'Public', given: 'Jane Q.' })
    expect(parseName('Madonna')).toEqual({ family: 'Madonna' })
    expect(parseName('European Commission')).toEqual({ family: 'European Commission' })
    const r = referenceFromPage(
      'https://x.org/p',
      '<html><head><script type="application/ld+json">{"@type":"NewsArticle","headline":"LD title","author":{"name":"Eve Ek"},"datePublished":"2024-02-02","publisher":{"name":"X Org"}}</script></head></html>',
    )
    expect(r).toMatchObject({ title: 'LD title', year: 2024, container: 'X Org' })
    expect(r.authors[0]).toEqual({ family: 'Ek', given: 'Eve' })
  })
})

describe('formatting', () => {
  const article: Reference = {
    type: 'article',
    title: 'Soil carbon & MRV',
    authors: [
      { family: 'Andersson', given: 'Anna' },
      { family: 'Berg', given: 'Bo Erik' },
      { family: 'Carlsson', given: 'Cecilia' },
    ],
    year: 2024,
    container: 'Journal of Soil Science',
    volume: '12',
    issue: '3',
    pages: '45-67',
    doi: '10.1000/soil.2024.1',
    url: 'https://doi.org/10.1000/soil.2024.1',
    source: 'crossref',
  }
  const web: Reference = {
    type: 'web',
    title: 'Soil Monitoring Law',
    authors: [],
    year: 2025,
    container: 'European Commission',
    url: 'https://environment.ec.europa.eu/soil',
    accessed: '2026-09-22',
    source: 'page',
  }

  it('APA 7', () => {
    expect(formatReference(article, 'apa')).toBe(
      'Andersson, A., Berg, B. E., & Carlsson, C. (2024). Soil carbon & MRV. Journal of Soil Science, 12(3), 45-67. https://doi.org/10.1000/soil.2024.1',
    )
    expect(inText(article, 'apa', 1)).toBe('(Andersson et al., 2024)')
    expect(formatReference(web, 'apa')).toBe(
      'European Commission (2025). Soil Monitoring Law. Retrieved 2026-09-22, from https://environment.ec.europa.eu/soil',
    )
    expect(inText(web, 'apa', 1)).toBe('(European Commission, 2025)')
  })

  it('Harvard, Vancouver and IEEE', () => {
    expect(formatReference(article, 'harvard')).toBe(
      "Andersson, A., Berg, B.E. and Carlsson, C. (2024) 'Soil carbon & MRV', Journal of Soil Science, 12(3), pp. 45-67. doi:10.1000/soil.2024.1",
    )
    expect(inText(article, 'harvard', 1)).toBe('(Andersson et al. 2024)')
    expect(formatReference(article, 'vancouver')).toBe(
      'Andersson A, Berg BE, Carlsson C. Soil carbon & MRV. Journal of Soil Science. 2024;12(3):45-67. doi:10.1000/soil.2024.1',
    )
    expect(inText(article, 'vancouver', 4)).toBe('[4]')
    expect(formatReference(article, 'ieee')).toBe(
      'A. Andersson, B. E. Berg, and C. Carlsson, "Soil carbon & MRV," Journal of Soil Science, vol. 12, no. 3, pp. 45-67, 2024, doi: 10.1000/soil.2024.1.',
    )
    const two: Reference = { ...article, authors: article.authors.slice(0, 2) }
    expect(inText(two, 'apa', 1)).toBe('(Andersson & Berg, 2024)')
    expect(inText(two, 'harvard', 1)).toBe('(Andersson and Berg 2024)')
  })
})

describe('cite MCP tools', () => {
  it('looks up and formats', async () => {
    await fakeApi()
    const tools = createCiteServer(citer()).tools
    const ctx = { env: {}, log: () => {} }
    const run = (name: string, args: Record<string, unknown>) =>
      tools.find((t) => t.name === name)!.run(args, ctx)
    const lookup = String(await run('cite_lookup', { query: 'soil carbon MRV' }))
    expect(lookup).toContain(
      '1. Andersson, Berg, Carlsson (2024). Soil carbon & MRV. Journal of Soil Science — doi:10.1000/soil.2024.1 [crossref]',
    )
    const formatted = String(
      await run('cite_format', {
        items: [
          '10.1000/soil.2024.1',
          'https://environment.ec.europa.eu/soil',
          {
            title: 'Own report',
            authors: ['Ecoera AB'],
            year: 2026,
            type: 'report',
            publisher: 'Ecoera',
          },
        ],
        style: 'vancouver',
        start: 3,
      }),
    )
    expect(formatted).toContain('References (Vancouver):')
    expect(formatted).toContain('[3] Andersson A, Berg BE, Carlsson C. Soil carbon & MRV.')
    expect(formatted).toContain('In-text: [3]')
    expect(formatted).toContain(
      '[4] Public JQ. Soil Monitoring Law explained [Internet]. European Commission; 2025',
    )
    expect(formatted).toContain('[5] Ecoera AB. Own report. Ecoera; 2026.')
    const none = await run('cite_format', { items: ['https://blocked.example/x'] })
    expect(none).toMatchObject({ isError: true })
  })
})
