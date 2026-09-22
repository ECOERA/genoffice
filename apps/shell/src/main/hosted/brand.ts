/**
 * Brand kit — a hosted MCP server (see mcp-host.ts) that keeps the user's
 * fonts, colours, logo and boilerplate in `~/.genoffice/brand.json` and
 * hands them to the assistant so it can apply them with the editors' own
 * tools ("use our brand": set fonts and colours, insert the logo, add the
 * footer). The logo is served through the media store so every editor's
 * image tool can insert it by URL.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { textResult, type HostedServer, type HostedTool } from '../mcp-host'

export interface BrandKit {
  name?: string
  tagline?: string
  fonts?: { heading?: string; body?: string; mono?: string }
  colors?: Record<string, string>
  logo?: { path?: string; url?: string; alt?: string }
  footer?: string
  address?: string
  website?: string
  tone?: string
  notes?: string
}

export interface BrandOptions {
  path: string
  /** copies a local image into the media store and returns its http URL */
  imageUrlFor?: (data: Buffer, mimeType: string) => string | null
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

const EXAMPLE: BrandKit = {
  name: 'Ecoera',
  tagline: 'Regenerative agriculture, measured.',
  fonts: { heading: 'Montserrat', body: 'Source Sans 3' },
  colors: {
    primary: '#2E6B3F',
    secondary: '#C8A25B',
    accent: '#1F4E8C',
    text: '#1D1B17',
    background: '#FBFAF7',
  },
  logo: { path: '~/Pictures/ecoera-logo.png', alt: 'Ecoera logo' },
  footer: 'Ecoera AB · Falkenberg · ecoera.se',
  tone: 'Concise, evidence-led, Swedish or English as the reader prefers.',
}

function expandHome(p: string): string {
  return resolve(p.startsWith('~') ? `${homedir()}${p.slice(1)}` : p)
}

export class Brand {
  private cachedLogoUrl: { path: string; mtime: number; url: string } | null = null
  constructor(private readonly opts: BrandOptions) {}

  read(): BrandKit | null {
    if (!existsSync(this.opts.path)) return null
    try {
      const parsed = JSON.parse(readFileSync(this.opts.path, 'utf8')) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as BrandKit) : null
    } catch (err) {
      throw new Error(
        `${this.opts.path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
  }

  write(kit: BrandKit): void {
    mkdirSync(dirname(this.opts.path), { recursive: true })
    writeFileSync(this.opts.path, `${JSON.stringify(kit, null, 2)}\n`, 'utf8')
  }

  /** merge fields into the kit (nested objects merged one level deep) */
  update(patch: BrandKit): BrandKit {
    const cur = this.read() ?? {}
    const next: BrandKit = { ...cur, ...patch }
    if (patch.fonts) next.fonts = { ...cur.fonts, ...patch.fonts }
    if (patch.colors) next.colors = { ...cur.colors, ...patch.colors }
    if (patch.logo) next.logo = { ...cur.logo, ...patch.logo }
    this.write(next)
    return next
  }

  /** the logo as an http URL the editors accept (served from the media store), when the file exists */
  logoUrl(kit: BrandKit): string | null {
    if (kit.logo?.url) return kit.logo.url
    if (!kit.logo?.path || !this.opts.imageUrlFor) return null
    const path = expandHome(kit.logo.path)
    if (!existsSync(path)) return null
    const mime = MIME[extname(path).toLowerCase()]
    if (!mime) return null
    const data = readFileSync(path)
    if (
      this.cachedLogoUrl &&
      this.cachedLogoUrl.path === path &&
      this.cachedLogoUrl.mtime === data.length
    )
      return this.cachedLogoUrl.url
    const url = this.opts.imageUrlFor(data, mime)
    if (url) this.cachedLogoUrl = { path, mtime: data.length, url }
    return url
  }

  describe(kit: BrandKit): string {
    const lines: string[] = []
    if (kit.name) lines.push(`Brand: ${kit.name}${kit.tagline ? ` — ${kit.tagline}` : ''}`)
    if (kit.fonts)
      lines.push(
        `Fonts: heading ${kit.fonts.heading ?? '(unset)'}, body ${kit.fonts.body ?? '(unset)'}${kit.fonts.mono ? `, mono ${kit.fonts.mono}` : ''}`,
      )
    if (kit.colors)
      lines.push(
        `Colours: ${Object.entries(kit.colors)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}`,
      )
    const logo = this.logoUrl(kit)
    if (logo)
      lines.push(
        `Logo: ${logo}${kit.logo?.alt ? ` (alt: ${kit.logo.alt})` : ''} — insert it with the editor's image tool using this URL`,
      )
    else if (kit.logo?.path) lines.push(`Logo: ${kit.logo.path} (file not found or not an image)`)
    if (kit.footer) lines.push(`Footer: ${kit.footer}`)
    if (kit.address) lines.push(`Address: ${kit.address}`)
    if (kit.website) lines.push(`Website: ${kit.website}`)
    if (kit.tone) lines.push(`Tone of voice: ${kit.tone}`)
    if (kit.notes) lines.push(`Notes: ${kit.notes}`)
    lines.push(
      '',
      'Apply it with the editor tools: fonts and colours on headings, body text, tables and charts; the logo top-left or on the title slide; the footer in the footer.',
    )
    return lines.join('\n')
  }
}

export function createBrandServer(brand: Brand): HostedServer {
  const tools: HostedTool[] = [
    {
      name: 'brand_get',
      description:
        "The user's brand kit (fonts, colours, logo URL, footer, tone of voice) to apply when they ask for their brand, house style or company look. Returns instructions; apply them with the editor's own formatting and image tools.",
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const kit = brand.read()
        if (!kit) {
          return `No brand kit yet. Ask the user for their fonts, colours and logo and save them with brand_set, or tell them to edit the file. Example:\n${JSON.stringify(EXAMPLE, null, 2)}`
        }
        return `${brand.describe(kit)}\n\nRaw kit:\n${JSON.stringify(kit, null, 2)}`
      },
    },
    {
      name: 'brand_set',
      description:
        'Save or update the brand kit: any of name, tagline, fonts {heading, body, mono}, colors {name: #hex}, logo {path or url, alt}, footer, address, website, tone, notes. Fields you omit are kept.',
      inputSchema: {
        type: 'object',
        properties: {
          kit: {
            type: 'object',
            description:
              'Fields to set, e.g. {"fonts": {"heading": "Montserrat"}, "colors": {"primary": "#2E6B3F"}}',
          },
        },
        required: ['kit'],
      },
      run: (args) => {
        const patch =
          args.kit && typeof args.kit === 'object' && !Array.isArray(args.kit)
            ? (args.kit as BrandKit)
            : null
        if (!patch || !Object.keys(patch).length)
          return textResult('kit must be an object with at least one field', true)
        for (const [k, v] of Object.entries(patch.colors ?? {})) {
          if (!/^#[0-9a-f]{3,8}$/i.test(String(v)))
            return textResult(
              `colour ${k} must be a hex value like #2E6B3F, got ${String(v)}`,
              true,
            )
        }
        const next = brand.update(patch)
        return `Brand kit saved.\n\n${brand.describe(next)}`
      },
    },
  ]
  return { name: 'brand', version: '1.0.0', tools }
}
