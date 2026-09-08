import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMcpImageStore, type McpImageStore } from '../src/main/mcp-images'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

let store: McpImageStore | null = null
let dir = ''
afterEach(() => {
  store?.close()
  store = null
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('MCP image store', () => {
  it('serves saved images from a token URL on loopback and nothing else', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-images-'))
    store = await startMcpImageStore(dir)
    expect(store.urlBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/)
    const url = store.save(PNG, 'image/png')
    expect(url.startsWith(store.urlBase + '/mcp-')).toBe(true)
    expect(url.endsWith('.png')).toBe(true)
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)

    // a file placed in the dir by a server (nano-banana writes its own) is reachable too
    writeFileSync(join(dir, 'nano-banana-x.jpg'), PNG)
    expect((await fetch(`${store.urlBase}/nano-banana-x.jpg`)).status).toBe(200)

    // wrong token, traversal, unknown types and other files stay hidden
    const origin = new URL(store.urlBase).origin
    expect((await fetch(`${origin}/not-the-token/${url.split('/').pop()}`)).status).toBe(404)
    expect((await fetch(`${store.urlBase}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404)
    writeFileSync(join(dir, 'secret.txt'), 'x')
    expect((await fetch(`${store.urlBase}/secret.txt`)).status).toBe(404)
    expect((await fetch(`${store.urlBase}/missing.png`)).status).toBe(404)
    expect((await fetch(url, { method: 'POST' })).status).toBe(404)
  })
})
