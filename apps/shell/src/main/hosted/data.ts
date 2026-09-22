/**
 * Data connectors — a hosted MCP server (see mcp-host.ts) that pulls series
 * from public statistics APIs and CSV files into compact tables the assistant
 * writes into a sheet, always with the source URL:
 *   Eurostat (JSON-stat 2.0), World Bank, FAOSTAT, Statistics Sweden (PxWeb),
 *   and any CSV URL. Dependency-free; endpoints are overridable for tests, and
 *   CSV downloads go through the injected (SSRF-guarded) fetcher.
 */
import { textResult, type HostedServer, type HostedTool } from '../mcp-host'

export interface DataOptions {
  /** downloads a text file (CSV); null when blocked or unreachable */
  fetchText: (url: string) => Promise<string | null>
  eurostatBase?: string
  worldbankBase?: string
  faostatBase?: string
  scbBase?: string
  timeoutMs?: number
}

export interface Table {
  columns: string[]
  rows: (string | number | null)[][]
  source: string
  note?: string
  total?: number
}

type Json = Record<string, unknown>
const asRecord = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** JSON-stat 2.0 dataset → one row per non-null cell, last dimension fastest */
export function decodeJsonStat(ds: Json): {
  columns: string[]
  rows: (string | number | null)[][]
} {
  const ids = asArray(ds.id).map(String)
  const size = asArray(ds.size).map(Number)
  const dimension = asRecord(ds.dimension)
  const dims = ids.map((id) => {
    const d = asRecord(dimension[id])
    const cat = asRecord(d.category)
    const index = cat.index
    const codes = Array.isArray(index)
      ? index.map(String)
      : Object.entries(asRecord(index))
          .sort((a, b) => Number(a[1]) - Number(b[1]))
          .map(([code]) => code)
    const labels = asRecord(cat.label)
    return { label: d.label ? String(d.label) : id, codes, labels }
  })
  const values = ds.value
  const total = size.reduce((a, b) => a * b, 1)
  const rows: (string | number | null)[][] = []
  for (let i = 0; i < total; i++) {
    const v = Array.isArray(values) ? values[i] : asRecord(values)[String(i)]
    if (v === null || v === undefined) continue
    const row: (string | number | null)[] = []
    let rem = i
    const coords: number[] = new Array(size.length)
    for (let k = size.length - 1; k >= 0; k--) {
      coords[k] = rem % size[k]!
      rem = Math.floor(rem / size[k]!)
    }
    dims.forEach((d, k) => {
      const code = d.codes[coords[k]!] ?? String(coords[k])
      row.push(d.labels[code] !== undefined ? String(d.labels[code]) : code)
    })
    row.push(typeof v === 'number' ? v : String(v))
    rows.push(row)
  }
  return { columns: [...dims.map((d) => d.label), 'value'], rows }
}

/** RFC 4180-ish CSV: quoted fields, doubled quotes, auto delimiter (, ; or tab) */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const first = (text.split(/\r?\n/, 1)[0] ?? '').replace(/"[^"]*"/g, '')
  const delim =
    delimiter ??
    [',', ';', '\t']
      .map((d) => [d, first.split(d).length] as const)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ??
    ','
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((c) => c !== '')) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((c) => c !== '')) rows.push(row)
  return rows
}

export function formatTable(t: Table, maxRows: number): string {
  const shown = t.rows.slice(0, maxRows)
  const lines = [
    `| ${t.columns.join(' | ')} |`,
    `| ${t.columns.map(() => '---').join(' | ')} |`,
    ...shown.map(
      (r) => `| ${r.map((c) => (c === null || c === undefined ? '' : String(c))).join(' | ')} |`,
    ),
  ]
  const total = t.total ?? t.rows.length
  const tail: string[] = ['']
  if (total > shown.length)
    tail.push(`(${shown.length} of ${total} rows shown — narrow the filters or raise max_rows)`)
  if (t.note) tail.push(t.note)
  tail.push(
    `Source: ${t.source}`,
    'Write the source URL into the sheet next to the data (a header cell or a note).',
  )
  return `${lines.join('\n')}\n${tail.join('\n')}`
}

export class DataConnectors {
  private readonly eurostatUrl: string
  private readonly worldbankUrl: string
  private readonly faostatUrl: string
  private readonly scbUrl: string
  constructor(private readonly opts: DataOptions) {
    const base = (v: string | undefined, d: string) => (v ?? d).replace(/\/+$/, '')
    this.eurostatUrl = base(
      opts.eurostatBase,
      'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data',
    )
    this.worldbankUrl = base(opts.worldbankBase, 'https://api.worldbank.org/v2')
    this.faostatUrl = base(opts.faostatBase, 'https://faostatservices.fao.org/api/v1/en')
    this.scbUrl = base(opts.scbBase, 'https://api.scb.se/OV0104/v1/doris/en/ssd')
  }

  private async json(url: string, init?: RequestInit): Promise<Json> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000)
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
      })
      const body = await res.text()
      if (!res.ok)
        throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}: ${body.slice(0, 200)}`)
      return JSON.parse(body) as Json
    } finally {
      clearTimeout(timer)
    }
  }

  async eurostat(dataset: string, filters: Record<string, string | string[]>): Promise<Table> {
    const u = new URL(`${this.eurostatUrl}/${encodeURIComponent(dataset)}`)
    u.searchParams.set('format', 'JSON')
    u.searchParams.set('lang', 'EN')
    for (const [k, v] of Object.entries(filters)) {
      for (const val of Array.isArray(v) ? v : String(v).split(','))
        if (val.trim()) u.searchParams.append(k, val.trim())
    }
    const ds = await this.json(u.toString())
    if (ds.error) throw new Error(`Eurostat: ${JSON.stringify(ds.error).slice(0, 300)}`)
    const { columns, rows } = decodeJsonStat(ds)
    const label = ds.label ? String(ds.label) : dataset
    return { columns, rows, source: u.toString(), note: `Eurostat dataset ${dataset}: ${label}` }
  }

  async worldbank(
    indicator: string,
    countries: string,
    from?: number,
    to?: number,
  ): Promise<Table> {
    const codes = countries.replace(/\s+/g, '').replace(/,/g, ';') || 'all'
    const u = new URL(
      `${this.worldbankUrl}/country/${encodeURIComponent(codes)}/indicator/${encodeURIComponent(indicator)}`,
    )
    u.searchParams.set('format', 'json')
    u.searchParams.set('per_page', '2000')
    if (from || to) u.searchParams.set('date', `${from ?? 1960}:${to ?? new Date().getFullYear()}`)
    const body = (await this.json(u.toString())) as unknown
    const [meta, data] = Array.isArray(body) ? body : [body, []]
    if (!Array.isArray(data))
      throw new Error(
        `World Bank: ${JSON.stringify(asRecord(asArray(meta)[0]).message ?? meta).slice(0, 300)}`,
      )
    const rows = data.map((d) => {
      const r = asRecord(d)
      return [
        String(asRecord(r.country).value ?? r.countryiso3code ?? ''),
        String(r.date ?? ''),
        typeof r.value === 'number' ? r.value : null,
      ]
    })
    const name = String(asRecord(asRecord(data[0]).indicator).value ?? indicator)
    return {
      columns: ['Country', 'Year', name],
      rows,
      source: u.toString(),
      note: `World Bank indicator ${indicator}`,
    }
  }

  async faostat(domain: string, params: Record<string, string>): Promise<Table> {
    const u = new URL(`${this.faostatUrl}/data/${encodeURIComponent(domain)}`)
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v)
    u.searchParams.set('output_type', 'objects')
    u.searchParams.set('show_codes', 'false')
    u.searchParams.set('show_unit', 'true')
    const body = await this.json(u.toString())
    const data = asArray(body.data).map(asRecord)
    if (!data.length)
      return {
        columns: ['Area', 'Item', 'Element', 'Year', 'Unit', 'Value'],
        rows: [],
        source: u.toString(),
        note: `FAOSTAT domain ${domain}`,
      }
    const columns = ['Area', 'Item', 'Element', 'Year', 'Unit', 'Value'].filter(
      (c) => c in data[0]!,
    )
    const rows = data.map((r) =>
      columns.map((c) =>
        typeof r[c] === 'number' ? (r[c] as number) : r[c] == null ? null : String(r[c]),
      ),
    )
    return { columns, rows, source: u.toString(), note: `FAOSTAT domain ${domain}` }
  }

  async scbMeta(table: string): Promise<string> {
    const u = `${this.scbUrl}/${table.replace(/^\/+/, '')}`
    const body = await this.json(u)
    const vars = asArray(body.variables).map(asRecord)
    const lines = [`SCB table ${table}: ${String(body.title ?? '')}`]
    for (const v of vars) {
      const values = asArray(v.values).map(String)
      const texts = asArray(v.valueTexts).map(String)
      const pairs = values.slice(0, 40).map((val, i) => `${val}=${texts[i] ?? ''}`)
      lines.push(
        `- ${String(v.code)} (${String(v.text)}${v.time ? ', time' : ''}${v.elimination ? ', optional' : ''}): ${pairs.join(', ')}${values.length > 40 ? `, … (${values.length} values)` : ''}`,
      )
    }
    lines.push('', `Build a scb_get query with these codes and values. Source: ${u}`)
    return lines.join('\n')
  }

  async scb(table: string, query: { code: string; values: string[] }[]): Promise<Table> {
    const u = `${this.scbUrl}/${table.replace(/^\/+/, '')}`
    const body = await this.json(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: query.map((q) => ({
          code: q.code,
          selection: {
            filter: q.values.length === 1 && q.values[0] === '*' ? 'all' : 'item',
            values: q.values,
          },
        })),
        response: { format: 'json' },
      }),
    })
    const columns = asArray(body.columns).map((c) =>
      String(asRecord(c).text ?? asRecord(c).code ?? ''),
    )
    const rows = asArray(body.data).map((d) => {
      const r = asRecord(d)
      return [
        ...asArray(r.key).map(String),
        ...asArray(r.values).map((v) =>
          typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : String(v),
        ),
      ]
    })
    return { columns, rows, source: u, note: `Statistics Sweden (SCB) table ${table}` }
  }

  async csv(url: string, delimiter?: string): Promise<Table> {
    const text = await this.opts.fetchText(url)
    if (text == null) throw new Error('Could not download the file (blocked or unreachable)')
    const rows = parseCsv(text, delimiter)
    if (!rows.length) throw new Error('The file is empty')
    const [header, ...data] = rows
    return { columns: header!, rows: data, source: url }
  }
}

function strings(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(asRecord(v)))
    if (val !== undefined && val !== null && val !== '')
      out[k] = Array.isArray(val) ? val.map(String).join(',') : String(val)
  return out
}

export function createDataServer(data: DataConnectors): HostedServer {
  const rowsArg = (args: Record<string, unknown>) => clamp(Number(args.max_rows) || 200, 1, 1000)
  const tools: HostedTool[] = [
    {
      name: 'eurostat_get',
      description:
        'Fetch a Eurostat dataset as a table (JSON-stat). Give the dataset code (e.g. tag00025, nrg_bal_c, sdg_02_40) and dimension filters such as geo=SE, time=2023 or sinceTimePeriod=2015, unit=… . Find codes with web search ("Eurostat <topic> dataset code"). Filter enough to stay under a few hundred rows.',
      inputSchema: {
        type: 'object',
        properties: {
          dataset: { type: 'string', description: 'Eurostat dataset code' },
          filters: {
            type: 'object',
            description: 'Dimension filters, e.g. {"geo": "SE,DK", "sinceTimePeriod": "2015"}',
            additionalProperties: { type: 'string' },
          },
          max_rows: { type: 'integer', description: '1–1000, default 200' },
        },
        required: ['dataset'],
      },
      run: async (args) => {
        const dataset = String(args.dataset ?? '').trim()
        if (!dataset) return textResult('dataset is required', true)
        return formatTable(await data.eurostat(dataset, strings(args.filters)), rowsArg(args))
      },
    },
    {
      name: 'worldbank_get',
      description:
        'Fetch a World Bank indicator (e.g. AG.LND.AGRI.ZS agricultural land %, EN.ATM.CO2E.PC CO2 per capita, NY.GDP.MKTP.CD GDP) for countries (ISO codes, e.g. "SE;DK;FI" or "all") and a year range.',
      inputSchema: {
        type: 'object',
        properties: {
          indicator: { type: 'string' },
          countries: {
            type: 'string',
            description: 'ISO2/ISO3 codes separated by ; (default all)',
          },
          from: { type: 'integer' },
          to: { type: 'integer' },
          max_rows: { type: 'integer', description: '1–1000, default 200' },
        },
        required: ['indicator'],
      },
      run: async (args) => {
        const indicator = String(args.indicator ?? '').trim()
        if (!indicator) return textResult('indicator is required', true)
        return formatTable(
          await data.worldbank(
            indicator,
            String(args.countries ?? 'all'),
            Number(args.from) || undefined,
            Number(args.to) || undefined,
          ),
          rowsArg(args),
        )
      },
    },
    {
      name: 'faostat_get',
      description:
        'Fetch FAOSTAT data: domain code (e.g. QCL crops and livestock, RFN fertilizers, GT emissions totals, FBS food balances) with area, element, item and year filters (codes or names as FAOSTAT uses them; comma-separated lists allowed).',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          area: { type: 'string', description: 'e.g. 210 (Sweden) or a list' },
          element: { type: 'string' },
          item: { type: 'string' },
          year: { type: 'string', description: 'e.g. 2020,2021,2022' },
          max_rows: { type: 'integer', description: '1–1000, default 200' },
        },
        required: ['domain'],
      },
      run: async (args) => {
        const domain = String(args.domain ?? '').trim()
        if (!domain) return textResult('domain is required', true)
        return formatTable(
          await data.faostat(
            domain,
            strings({ area: args.area, element: args.element, item: args.item, year: args.year }),
          ),
          rowsArg(args),
        )
      },
    },
    {
      name: 'scb_meta',
      description:
        'Describe a Statistics Sweden (SCB) PxWeb table: its variables, codes and values, so you can build an scb_get query. Table path e.g. BE/BE0101/BE0101A/BefolkningNy or JO/JO0104/JO0104B/ArealAr.',
      inputSchema: {
        type: 'object',
        properties: { table: { type: 'string' } },
        required: ['table'],
      },
      run: async (args) => {
        const table = String(args.table ?? '').trim()
        if (!table) return textResult('table is required', true)
        return data.scbMeta(table)
      },
    },
    {
      name: 'scb_get',
      description:
        'Fetch a Statistics Sweden (SCB) PxWeb table with a query: one entry per variable code with the values to select ("*" for all). Use scb_meta first to see the codes.',
      inputSchema: {
        type: 'object',
        properties: {
          table: { type: 'string' },
          query: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                values: { type: 'array', items: { type: 'string' } },
              },
              required: ['code', 'values'],
            },
          },
          max_rows: { type: 'integer', description: '1–1000, default 200' },
        },
        required: ['table', 'query'],
      },
      run: async (args) => {
        const table = String(args.table ?? '').trim()
        const query = asArray(args.query)
          .map((q) => ({
            code: String(asRecord(q).code ?? ''),
            values: asArray(asRecord(q).values).map(String),
          }))
          .filter((q) => q.code)
        if (!table || !query.length) return textResult('table and query are required', true)
        return formatTable(await data.scb(table, query), rowsArg(args))
      },
    },
    {
      name: 'csv_fetch',
      description:
        'Download a CSV (or TSV / semicolon-separated) file from an http(s) URL and return it as a table, first row as header.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          delimiter: { type: 'string', description: 'Auto-detected when omitted' },
          max_rows: { type: 'integer', description: '1–1000, default 200' },
        },
        required: ['url'],
      },
      run: async (args) => {
        const url = String(args.url ?? '').trim()
        if (!/^https?:\/\//i.test(url)) return textResult('url must be an http(s) URL', true)
        const delimiter =
          typeof args.delimiter === 'string' && args.delimiter
            ? args.delimiter === '\\t'
              ? '\t'
              : args.delimiter
            : undefined
        return formatTable(await data.csv(url, delimiter), rowsArg(args))
      },
    },
  ]
  return { name: 'data', version: '1.0.0', tools }
}
