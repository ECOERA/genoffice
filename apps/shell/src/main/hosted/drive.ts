/**
 * Google Drive — a hosted MCP server (see mcp-host.ts) on the Drive sign-in:
 * search Drive by name or contents, read a file's text (downloaded into the
 * app's Drive cache and indexed into the knowledge base on the way), and
 * open a file in the editor. Google Docs/Sheets/Slides come through the
 * cache as docx/xlsx/pptx exports, so their text is readable too.
 * The service is injected (GoogleDriveService in the app, a fake in tests).
 */
import { basename } from 'node:path'
import type { GoogleDriveFileEntry } from '../../shared/home-api'
import { textResult, type HostedServer, type HostedTool } from '../mcp-host'
import type { ParsedText } from './kb'

export interface DriveLike {
  signedIn(): boolean
  search(query: string, opts: { fullText?: boolean; max?: number }): Promise<GoogleDriveFileEntry[]>
  fetchToCache(fileId: string): Promise<{ path: string }>
  open(fileId: string): Promise<{ path: string }>
}

export interface DriveOptions {
  drive: () => DriveLike
  parse: (path: string) => Promise<ParsedText>
  /** adds the downloaded copy to the knowledge base (best effort) */
  index?: (path: string) => Promise<unknown>
}

const NOT_SIGNED_IN =
  'Not signed in to Google Drive: sign in from the Home view (Google Drive) first.'
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

function describe(f: GoogleDriveFileEntry): string {
  const size = f.size ? ` · ${Math.max(1, Math.round(f.size / 1024))} KB` : ''
  return `${f.name} (${f.googleNative ? `Google ${f.kind}` : f.ext}${size}, modified ${new Date(f.modifiedMs).toISOString().slice(0, 10)}) — id ${f.id}`
}

export function createDriveServer(opts: DriveOptions): HostedServer {
  const tools: HostedTool[] = [
    {
      name: 'drive_search',
      description:
        "Search the user's Google Drive (documents, spreadsheets, presentations, PDFs; Google-native files included) by contents and name. Returns name, type, date and the file id for drive_read / drive_open. For files already on this computer, kb_search is faster.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to find in the contents or the name' },
          max: { type: 'integer', description: '1–50, default 10' },
          names_only: { type: 'boolean', description: 'Match file names only, default false' },
        },
        required: ['query'],
      },
      run: async (args) => {
        const query = String(args.query ?? '').trim()
        if (!query) return textResult('query must not be empty', true)
        const drive = opts.drive()
        if (!drive.signedIn()) return textResult(NOT_SIGNED_IN, true)
        const files = await drive.search(query, {
          fullText: args.names_only !== true,
          max: clamp(Number(args.max) || 10, 1, 50),
        })
        if (!files.length) return `Nothing in Google Drive matches "${query}".`
        return [
          `Google Drive files matching "${query}":`,
          ...files.map((f, i) => `${i + 1}. ${describe(f)}`),
          '',
          'Use drive_read with an id for the text, or drive_open to open it in the editor.',
        ].join('\n')
      },
    },
    {
      name: 'drive_read',
      description:
        'Read the text of a Google Drive file by id (downloaded into the app cache; Google Docs/Sheets/Slides are exported). Long files come in chunks: call again with offset. The copy is added to the knowledge base for later kb_search.',
      inputSchema: {
        type: 'object',
        properties: {
          file_id: { type: 'string' },
          offset: { type: 'integer', description: 'Start position, default 0' },
          max_chars: { type: 'integer', description: '500–40000, default 12000' },
        },
        required: ['file_id'],
      },
      run: async (args) => {
        const id = String(args.file_id ?? '').trim()
        if (!id) return textResult('file_id is required', true)
        const drive = opts.drive()
        if (!drive.signedIn()) return textResult(NOT_SIGNED_IN, true)
        const { path } = await drive.fetchToCache(id)
        const parsed = await opts.parse(path)
        if (!parsed.ok || !parsed.text.trim())
          return textResult(
            `No readable text in ${basename(path)}${parsed.error ? ` (${parsed.error})` : ''}`,
            true,
          )
        void opts.index?.(path).catch(() => {})
        const offset = Math.max(0, Number(args.offset) || 0)
        const maxChars = clamp(Number(args.max_chars) || 12_000, 500, 40_000)
        const text = parsed.text
        const piece = text.slice(offset, offset + maxChars)
        const rest = text.length - (offset + piece.length)
        const more =
          rest > 0
            ? `\n\n[truncated: ${rest} more characters — call drive_read again with offset=${offset + piece.length}]`
            : ''
        return `File: ${basename(path)} (Drive id ${id})\nLength: ${text.length} characters${offset ? ` (from ${offset})` : ''}\n\n${piece}${more}`
      },
    },
    {
      name: 'drive_open',
      description:
        'Open a Google Drive file in the matching DuneOffice editor (downloads it first; edits sync back to Drive when the file is saved).',
      inputSchema: {
        type: 'object',
        properties: { file_id: { type: 'string' } },
        required: ['file_id'],
      },
      run: async (args) => {
        const id = String(args.file_id ?? '').trim()
        if (!id) return textResult('file_id is required', true)
        const drive = opts.drive()
        if (!drive.signedIn()) return textResult(NOT_SIGNED_IN, true)
        const { path } = await drive.open(id)
        return `Opened ${basename(path)} in the editor.`
      },
    },
  ]
  return { name: 'drive', version: '1.0.0', tools }
}
