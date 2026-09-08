/**
 * Loopback image server for MCP results. The editors insert pictures only
 * from http(s) URLs they download themselves, so images produced by MCP
 * servers (Nano Banana and the like) are written under userData and served
 * from 127.0.0.1 behind a per-run random token. Nothing else on disk is
 * reachable: one directory, file names sanitized to a single path segment.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { basename, extname, join } from 'node:path'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export interface McpImageStore {
  /** absolute directory generated images live in */
  dir: string
  /** http origin + token prefix; `${urlBase}/${fileName}` serves a file of `dir` */
  urlBase: string
  /** writes bytes into the store and returns the URL */
  save(data: Buffer, mimeType: string): string
  close(): void
}

function extFor(mimeType: string): string {
  const m = mimeType.toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg'
  if (m.includes('webp')) return '.webp'
  if (m.includes('gif')) return '.gif'
  return '.png'
}

/** Binds an ephemeral port on 127.0.0.1; resolves once listening. */
export function startMcpImageStore(dir: string): Promise<McpImageStore> {
  mkdirSync(dir, { recursive: true })
  const token = randomBytes(16).toString('hex')
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const [, seg, name] = url.pathname.split('/')
      if (seg !== token || !name || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.writeHead(404).end()
        return
      }
      const file = join(dir, basename(decodeURIComponent(name)))
      const type = MIME[extname(file).toLowerCase()]
      if (!type || !existsSync(file)) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, {
        'content-type': type,
        'content-length': statSync(file).size,
        'cache-control': 'no-store',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(file).pipe(res)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      const urlBase = `http://127.0.0.1:${port}/${token}`
      resolve({
        dir,
        urlBase,
        save: (data, mimeType) => {
          const name = `mcp-${randomUUID()}${extFor(mimeType)}`
          writeFileSync(join(dir, name), data)
          return `${urlBase}/${name}`
        },
        close: () => server.close(),
      })
    })
  })
}
