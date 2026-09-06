import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoogleDriveService, fileKindFor } from '../src/main/google-drive'
import type { GoogleDriveSyncEvent } from '../src/shared/home-api'

const dirs: string[] = []
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'duneoffice-drive-svc-'))
  dirs.push(d)
  return d
}
const services: GoogleDriveService[] = []
afterEach(() => {
  for (const s of services.splice(0)) s.dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const DOC = {
  id: 'doc1',
  name: 'Plan',
  mimeType: 'application/vnd.google-apps.document',
  modifiedTime: '2026-09-01T10:00:00.000Z',
  webViewLink: 'https://docs.google.com/document/d/doc1',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A fake of the Google endpoints the service talks to; records every call. */
function fakeGoogle(overrides: { file?: typeof DOC; failUpload?: boolean } = {}) {
  const calls: { method: string; url: string; body?: string }[] = []
  // mutable like the real Drive: a successful upload bumps modifiedTime for later reads
  let file = overrides.file ?? DOC
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      method: init?.method ?? 'GET',
      url,
      body:
        typeof init?.body === 'string'
          ? init.body
          : init?.body
            ? Buffer.from(init.body as Buffer).toString()
            : undefined,
    })
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return jsonResponse({
        access_token: 'acc',
        refresh_token: 'ref',
        expires_in: 3600,
        scope: 'drive',
      })
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke'))
      return new Response('', { status: 200 })
    if (url.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) {
      return jsonResponse({ email: 'ann@example.com', name: 'Ann' })
    }
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) {
      return jsonResponse({ files: [file] })
    }
    if (url.includes(`/drive/v3/files/${file.id}/export`))
      return new Response('exported-bytes', { status: 200 })
    // metadata GET only: the upload URL below also contains this path as a substring
    if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${file.id}?`)) {
      return jsonResponse(file)
    }
    if (url.includes(`/upload/drive/v3/files/${file.id}?uploadType=media`)) {
      if (overrides.failUpload) return jsonResponse({ error: { message: 'quota' } }, 403)
      file = { ...file, modifiedTime: '2026-09-02T00:00:00.000Z' }
      return jsonResponse(file)
    }
    if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
      return jsonResponse({
        id: 'new1',
        name: 'local.md',
        mimeType: 'text/markdown',
        modifiedTime: 't',
      })
    }
    throw new Error(`unexpected request ${url}`)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function makeService(
  userData: string,
  google: ReturnType<typeof fakeGoogle>,
  extra: Partial<ConstructorParameters<typeof GoogleDriveService>[0]> = {},
) {
  const events: GoogleDriveSyncEvent[] = []
  const opened: string[] = []
  const svc = new GoogleDriveService({
    userData,
    settingsPath: join(userData, 'app-settings.json'),
    env: { DUNEOFFICE_GOOGLE_CLIENT_ID: 'cid', DUNEOFFICE_GOOGLE_CLIENT_SECRET: 'sec' },
    openExternal: async (authUrl) => {
      // the fake browser completes the loopback redirect at once
      const u = new URL(authUrl)
      const cb = new URL(u.searchParams.get('redirect_uri')!)
      cb.searchParams.set('code', 'code')
      cb.searchParams.set('state', u.searchParams.get('state')!)
      await fetch(cb)
    },
    openDocument: (path) => {
      opened.push(path)
      return true
    },
    emit: (ev) => events.push(ev),
    fetchImpl: google.fetchImpl,
    settleMs: 60,
    pollMs: 100,
    ...extra,
  })
  services.push(svc)
  return { svc, events, opened }
}

async function until(
  cond: () => boolean,
  detail: () => unknown = () => '',
  ms = 3000,
): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting; saw ${JSON.stringify(detail())}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('GoogleDriveService', () => {
  it('reads the OAuth client from settings, then env, then build metadata', () => {
    const userData = scratch()
    const google = fakeGoogle()
    const { svc } = makeService(userData, google, {
      buildConfig: { clientId: 'built', clientSecret: 'bs' },
    })
    expect(svc.getConfig()).toEqual({ clientId: 'cid', clientSecret: 'sec', source: 'env' })
    expect(svc.setConfig({ clientId: ' from-settings ', clientSecret: '' })).toEqual({
      clientId: 'from-settings',
      clientSecret: '',
      source: 'settings',
    })
    expect(svc.setConfig({ clientId: '', clientSecret: '' }).source).toBe('env')
    const { svc: svc2 } = makeService(userData, google, {
      env: {},
      buildConfig: { clientId: 'built' },
    })
    expect(svc2.getConfig()).toEqual({ clientId: 'built', clientSecret: '', source: 'build' })
    const { svc: svc3 } = makeService(userData, google, { env: {} })
    expect(svc3.status()).toEqual({ configured: false, signedIn: false })
  })

  it('signs in through the loopback flow, persists protected tokens, and reloads them', async () => {
    const userData = scratch()
    const google = fakeGoogle()
    const protect = {
      encrypt: (plain: string) => Buffer.from(plain.split('').reverse().join('')),
      decrypt: (data: Buffer) => data.toString().split('').reverse().join(''),
    }
    const { svc } = makeService(userData, google, { protect })
    expect(svc.status()).toEqual({ configured: true, signedIn: false })
    const status = await svc.login()
    expect(status).toMatchObject({
      configured: true,
      signedIn: true,
      email: 'ann@example.com',
      name: 'Ann',
    })
    const stored = JSON.parse(readFileSync(join(userData, 'google-drive', 'auth.json'), 'utf8'))
    expect(stored.enc).toBe(true)
    expect(Buffer.from(stored.data, 'base64').toString()).not.toContain('acc')

    const { svc: again } = makeService(userData, google, { protect })
    expect(again.status()).toMatchObject({ signedIn: true, email: 'ann@example.com' })
    await again.logout()
    expect(again.status().signedIn).toBe(false)
    expect(existsSync(join(userData, 'google-drive', 'auth.json'))).toBe(false)
    expect(google.calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke'))).toBe(
      true,
    )
  })

  it('lists files as entries with kind and extension', async () => {
    const userData = scratch()
    const google = fakeGoogle()
    const { svc } = makeService(userData, google)
    await svc.login()
    const page = await svc.list({ search: 'plan' })
    expect(page.files).toEqual([
      expect.objectContaining({
        id: 'doc1',
        name: 'Plan',
        kind: 'docs',
        ext: 'docx',
        googleNative: true,
      }),
    ])
    expect(new URL(google.calls.at(-1)!.url).searchParams.get('q')).toContain(
      "name contains 'plan'",
    )
    expect(fileKindFor({ name: 'x.pdf', mimeType: 'application/pdf' })).toBe('pdf')
    expect(fileKindFor({ name: 'x.zip', mimeType: 'application/zip' })).toBe('other')
  })

  it('opens a file into the cache and uploads it after a save settles', async () => {
    const userData = scratch()
    const google = fakeGoogle()
    const { svc, events, opened } = makeService(userData, google)
    await svc.login()
    const { path } = await svc.open('doc1')
    expect(path).toBe(join(userData, 'google-drive', 'files', 'doc1', 'Plan.docx'))
    expect(readFileSync(path, 'utf8')).toBe('exported-bytes')
    expect(opened).toEqual([path])
    expect(svc.boundFile(path)).toEqual({ fileId: 'doc1', name: 'Plan' })
    expect((await svc.list()).files[0]).toMatchObject({ cachedPath: path })

    // the editor saves: an atomic temp+rename like the docs app does
    writeFileSync(`${path}.tmp`, 'edited-bytes')
    renameSync(`${path}.tmp`, path)
    await until(() => events.some((e) => e.phase === 'done'))
    expect(events.map((e) => e.phase)).toEqual(['uploading', 'done'])
    const upload = google.calls.find((c) => c.method === 'PATCH')!
    expect(upload.url).toContain('/upload/drive/v3/files/doc1?uploadType=media')
    expect(upload.body).toBe('edited-bytes')

    // reopening a current, clean copy does not download again
    const downloadsBefore = google.calls.filter((c) => c.url.includes('/export')).length
    await svc.open('doc1')
    expect(google.calls.filter((c) => c.url.includes('/export')).length).toBe(downloadsBefore)
  })

  it('keeps a locally edited copy instead of re-downloading, and reports upload errors', async () => {
    const userData = scratch()
    const google = fakeGoogle({ failUpload: true })
    const { svc, events } = makeService(userData, google)
    await svc.login()
    const { path } = await svc.open('doc1')
    writeFileSync(path, 'local-edit')
    await until(
      () => events.some((e) => e.phase === 'error'),
      () => ({ events, calls: google.calls.map((c) => `${c.method} ${c.url.slice(0, 80)}`) }),
    )
    expect(events.at(-1)).toMatchObject({ phase: 'error', fileId: 'doc1' })
    expect(events.at(-1)!.error).toContain('quota')
    // remote changed meanwhile, but the unsynced local edit wins
    const changed = { ...DOC, modifiedTime: '2026-09-05T00:00:00.000Z' }
    const google2 = fakeGoogle({ file: changed })
    const { svc: svc2 } = makeService(userData, google2)
    await svc2.open('doc1')
    expect(readFileSync(path, 'utf8')).toBe('local-edit')
  })

  it('re-downloads when Drive changed and the local copy is clean', async () => {
    const userData = scratch()
    const google = fakeGoogle()
    const { svc } = makeService(userData, google)
    await svc.login()
    await svc.open('doc1')
    svc.dispose()
    const google2 = fakeGoogle({ file: { ...DOC, modifiedTime: '2026-09-09T00:00:00.000Z' } })
    const { svc: svc2 } = makeService(userData, google2)
    await svc2.open('doc1')
    expect(google2.calls.filter((c) => c.url.includes('/export')).length).toBe(1)
  })

  it('uploads a local document as a new Drive file and binds it for write-back', async () => {
    const userData = scratch()
    const google = fakeGoogle()
    const { svc, events } = makeService(userData, google)
    await svc.login()
    const local = join(scratch(), 'local.md')
    writeFileSync(local, '# one')
    const entry = await svc.upload(local)
    expect(entry).toMatchObject({ id: 'new1', kind: 'markdown', ext: 'md' })
    expect(svc.boundFile(local)).toEqual({ fileId: 'new1', name: 'local.md' })
    const create = google.calls.find((c) => c.url.includes('uploadType=multipart'))!
    expect(create.body).toContain('# one')
    writeFileSync(local, '# two')
    await until(() => events.some((e) => e.fileId === 'new1' && e.phase !== 'uploading'))
    expect(events.at(-1)!.phase).toBe('error') // the fake has no PATCH route for new1
  })
})
