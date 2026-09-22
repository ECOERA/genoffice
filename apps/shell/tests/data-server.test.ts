import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createDataServer, DataConnectors, decodeJsonStat, parseCsv } from '../src/main/hosted/data'

/** Data connectors against fake Eurostat / World Bank / FAOSTAT / SCB endpoints, plus CSV parsing. */

const JSONSTAT = {
  version: '2.0',
  class: 'dataset',
  label: 'Organic crop area',
  id: ['geo', 'time'],
  size: [2, 2],
  dimension: {
    geo: {
      label: 'Geopolitical entity',
      category: { index: { SE: 0, DK: 1 }, label: { SE: 'Sweden', DK: 'Denmark' } },
    },
    time: {
      label: 'Time',
      category: { index: ['2022', '2023'], label: { '2022': '2022', '2023': '2023' } },
    },
  },
  value: { '0': 20.1, '1': 20.4, '3': 11.9 },
}

let server: Server | null = null
let base = ''
const requests: { method: string; url: string; body: string }[] = []
afterEach(() => {
  server?.close()
  server = null
  requests.length = 0
})

function fake(): Promise<void> {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const url = req.url ?? ''
      requests.push({ method: req.method ?? '', url, body: raw })
      res.setHeader('content-type', 'application/json')
      if (url.startsWith('/eurostat/org_cropar')) return res.end(JSON.stringify(JSONSTAT))
      if (url.startsWith('/eurostat/'))
        return res
          .writeHead(400)
          .end(JSON.stringify({ error: { status: 400, label: 'Dataset not found' } }))
      if (url.startsWith('/wb/country/')) {
        return res.end(
          JSON.stringify([
            { page: 1, pages: 1, total: 2 },
            [
              {
                indicator: { id: 'AG.LND.AGRI.ZS', value: 'Agricultural land (% of land area)' },
                country: { id: 'SE', value: 'Sweden' },
                countryiso3code: 'SWE',
                date: '2022',
                value: 7.4,
              },
              {
                indicator: { id: 'AG.LND.AGRI.ZS', value: 'Agricultural land (% of land area)' },
                country: { id: 'SE', value: 'Sweden' },
                countryiso3code: 'SWE',
                date: '2021',
                value: null,
              },
            ],
          ]),
        )
      }
      if (url.startsWith('/fao/data/QCL')) {
        return res.end(
          JSON.stringify({
            data: [
              {
                Area: 'Sweden',
                Item: 'Wheat',
                Element: 'Production',
                Year: 2022,
                Unit: 't',
                Value: 2900000,
              },
            ],
          }),
        )
      }
      if (url.startsWith('/scb/JO/')) {
        if (req.method === 'GET') {
          return res.end(
            JSON.stringify({
              title: 'Arable land by county',
              variables: [
                {
                  code: 'Region',
                  text: 'region',
                  values: ['00', '01'],
                  valueTexts: ['Sweden', 'Stockholm'],
                },
                { code: 'Tid', text: 'year', values: ['2022'], valueTexts: ['2022'], time: true },
              ],
            }),
          )
        }
        return res.end(
          JSON.stringify({
            columns: [
              { code: 'Region', text: 'region', type: 'd' },
              { code: 'Tid', text: 'year', type: 't' },
              { code: 'JO0104A1', text: 'Arable land, hectares', type: 'c' },
            ],
            data: [{ key: ['00', '2022'], values: ['2540000'] }],
          }),
        )
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

function connectors(): DataConnectors {
  return new DataConnectors({
    fetchText: async (url) =>
      url.endsWith('.csv') ? 'name;"value, big"\n"Sweden";1\n"Den""mark";2\n' : null,
    eurostatBase: `${base}/eurostat`,
    worldbankBase: `${base}/wb`,
    faostatBase: `${base}/fao`,
    scbBase: `${base}/scb`,
  })
}

describe('decoders', () => {
  it('decodes JSON-stat with the last dimension fastest and skips empty cells', () => {
    const { columns, rows } = decodeJsonStat(JSONSTAT as never)
    expect(columns).toEqual(['Geopolitical entity', 'Time', 'value'])
    expect(rows).toEqual([
      ['Sweden', '2022', 20.1],
      ['Sweden', '2023', 20.4],
      ['Denmark', '2023', 11.9],
    ])
  })
  it('parses CSV with quotes, doubled quotes and delimiter detection', () => {
    expect(parseCsv('a,b\n"x, y","z""q"\n\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'z"q'],
    ])
    expect(parseCsv('a;b\r\n1;2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('data MCP tools', () => {
  it('Eurostat: builds the URL with filters and returns a sourced table', async () => {
    await fake()
    const tools = createDataServer(connectors()).tools
    const ctx = { env: {}, log: () => {} }
    const run = (name: string, args: Record<string, unknown>) =>
      tools.find((t) => t.name === name)!.run(args, ctx)
    const out = String(
      await run('eurostat_get', {
        dataset: 'org_cropar',
        filters: { geo: 'SE,DK', sinceTimePeriod: '2022' },
      }),
    )
    expect(out).toContain('| Geopolitical entity | Time | value |')
    expect(out).toContain('| Sweden | 2023 | 20.4 |')
    expect(out).toContain('Eurostat dataset org_cropar: Organic crop area')
    expect(out).toContain('Source: ')
    const u = new URL(requests[0]!.url, base)
    expect(u.searchParams.getAll('geo')).toEqual(['SE', 'DK'])
    expect(u.searchParams.get('sinceTimePeriod')).toBe('2022')
    expect(u.searchParams.get('format')).toBe('JSON')
    await expect(run('eurostat_get', { dataset: 'nope' })).rejects.toThrow(/Dataset not found/)
  })

  it('World Bank, FAOSTAT and SCB', async () => {
    await fake()
    const tools = createDataServer(connectors()).tools
    const ctx = { env: {}, log: () => {} }
    const run = (name: string, args: Record<string, unknown>) =>
      tools.find((t) => t.name === name)!.run(args, ctx)
    const wb = String(
      await run('worldbank_get', {
        indicator: 'AG.LND.AGRI.ZS',
        countries: 'SE',
        from: 2021,
        to: 2022,
      }),
    )
    expect(wb).toContain('| Country | Year | Agricultural land (% of land area) |')
    expect(wb).toContain('| Sweden | 2022 | 7.4 |')
    expect(wb).toContain('| Sweden | 2021 |  |')
    expect(new URL(requests.at(-1)!.url, base).searchParams.get('date')).toBe('2021:2022')
    const fao = String(
      await run('faostat_get', { domain: 'QCL', area: '210', item: '15', year: '2022' }),
    )
    expect(fao).toContain('| Sweden | Wheat | Production | 2022 | t | 2900000 |')
    const meta = String(await run('scb_meta', { table: 'JO/JO0104/JO0104B/ArealAr' }))
    expect(meta).toContain('Region (region): 00=Sweden, 01=Stockholm')
    expect(meta).toContain('Tid (year, time)')
    const scb = String(
      await run('scb_get', {
        table: 'JO/JO0104/JO0104B/ArealAr',
        query: [
          { code: 'Region', values: ['00'] },
          { code: 'Tid', values: ['*'] },
        ],
      }),
    )
    expect(scb).toContain('| region | year | Arable land, hectares |')
    expect(scb).toContain('| 00 | 2022 | 2540000 |')
    const body = JSON.parse(requests.at(-1)!.body) as {
      query: { code: string; selection: { filter: string; values: string[] } }[]
    }
    expect(body.query[1]).toEqual({ code: 'Tid', selection: { filter: 'all', values: ['*'] } })
  })

  it('CSV through the guarded fetcher, with row cap', async () => {
    await fake()
    const tools = createDataServer(connectors()).tools
    const ctx = { env: {}, log: () => {} }
    const run = (name: string, args: Record<string, unknown>) =>
      tools.find((t) => t.name === name)!.run(args, ctx)
    const out = String(await run('csv_fetch', { url: 'https://example.org/data.csv', max_rows: 1 }))
    expect(out).toContain('| name | value, big |')
    expect(out).toContain('| Sweden | 1 |')
    expect(out).not.toContain('Den"mark')
    expect(out).toContain('(1 of 2 rows shown')
    await expect(run('csv_fetch', { url: 'https://example.org/blocked.txt' })).rejects.toThrow(
      /Could not download/,
    )
  })
})
