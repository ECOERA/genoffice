import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GoogleDriveError,
  buildAuthUrl,
  createDriveFile,
  createPkce,
  downloadDriveFile,
  exchangeCode,
  listDriveFiles,
  localNameFor,
  loopbackLogin,
  openableFilesQuery,
  refreshAccessToken,
  updateDriveFileContent,
} from '../src/main/google-drive-api'

const cfg = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const dirs: string[] = []
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'duneoffice-drive-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('OAuth helpers', () => {
  it('builds a PKCE authorization url with offline access and forced consent', () => {
    const { verifier, challenge } = createPkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{60,}$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const url = new URL(
      buildAuthUrl(cfg, {
        redirectUri: 'http://127.0.0.1:1234/oauth2/callback',
        state: 's',
        challenge,
      }),
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(cfg.clientId)
    expect(url.searchParams.get('code_challenge')).toBe(challenge)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/drive')
  })

  it('exchanges a code for tokens and keeps the refresh token across refreshes', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body))
      calls.push(params.get('grant_type')!)
      if (params.get('grant_type') === 'authorization_code') {
        expect(params.get('code_verifier')).toBe('v')
        return jsonResponse({
          access_token: 'a1',
          refresh_token: 'r1',
          expires_in: 3600,
          scope: 'drive',
        })
      }
      expect(params.get('refresh_token')).toBe('r1')
      return jsonResponse({ access_token: 'a2', expires_in: 3600 })
    }) as unknown as typeof fetch
    const t1 = await exchangeCode(
      cfg,
      { code: 'c', redirectUri: 'http://127.0.0.1:1/x', verifier: 'v' },
      fetchImpl,
    )
    expect(t1).toMatchObject({ accessToken: 'a1', refreshToken: 'r1', scope: 'drive' })
    expect(t1.expiresAt).toBeGreaterThan(Date.now() + 3000 * 1000)
    const t2 = await refreshAccessToken(cfg, t1, fetchImpl)
    expect(t2).toMatchObject({ accessToken: 'a2', refreshToken: 'r1', scope: 'drive' })
    expect(calls).toEqual(['authorization_code', 'refresh_token'])
  })

  it('flags invalid_grant as needing a new sign-in', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { error: 'invalid_grant', error_description: 'Token has been revoked.' },
        400,
      )) as typeof fetch
    const err = await refreshAccessToken(
      cfg,
      { accessToken: 'a', refreshToken: 'r', expiresAt: 0, scope: '' },
      fetchImpl,
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleDriveError)
    expect((err as GoogleDriveError).reauth).toBe(true)
    expect((err as GoogleDriveError).message).toContain('invalid_grant')
  })

  it('runs the loopback flow end to end against a fake browser', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body))
      expect(params.get('code')).toBe('the-code')
      expect(params.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/)
      return jsonResponse({
        access_token: 'tok',
        refresh_token: 'ref',
        expires_in: 3600,
        scope: 'drive',
      })
    }) as unknown as typeof fetch
    const tokens = await loopbackLogin(cfg, {
      fetchImpl,
      openExternal: async (authUrl) => {
        // The "browser": Google redirects back to the loopback with code + state.
        const u = new URL(authUrl)
        const cb = new URL(u.searchParams.get('redirect_uri')!)
        cb.searchParams.set('code', 'the-code')
        cb.searchParams.set('state', u.searchParams.get('state')!)
        const res = await fetch(cb)
        expect(res.status).toBe(200)
        expect(await res.text()).toContain('DuneOffice')
      },
    })
    expect(tokens).toMatchObject({ accessToken: 'tok', refreshToken: 'ref' })
  })

  it('rejects a callback whose state does not match', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      loopbackLogin(cfg, {
        fetchImpl,
        openExternal: async (authUrl) => {
          const cb = new URL(new URL(authUrl).searchParams.get('redirect_uri')!)
          cb.searchParams.set('code', 'x')
          cb.searchParams.set('state', 'forged')
          await fetch(cb)
        },
      }),
    ).rejects.toThrow(/invalid callback/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('aborts the wait when the signal fires', async () => {
    const ac = new AbortController()
    const p = loopbackLogin(cfg, { openExternal: () => ac.abort(), signal: ac.signal })
    await expect(p).rejects.toThrow(/cancelled/)
  })
})

describe('Drive REST', () => {
  it('lists openable files newest first and normalizes the fields', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      const u = new URL(String(url))
      expect(u.pathname).toBe('/drive/v3/files')
      expect(u.searchParams.get('q')).toBe(openableFilesQuery('Q1 "plan\'s"'))
      expect(u.searchParams.get('orderBy')).toBe('modifiedTime desc')
      return jsonResponse({
        nextPageToken: 'n',
        files: [{ id: '1', name: 'a.docx', mimeType: 'x', modifiedTime: 't', size: '12' }],
      })
    }) as unknown as typeof fetch
    const page = await listDriveFiles(
      'tok',
      { query: openableFilesQuery('Q1 "plan\'s"') },
      fetchImpl,
    )
    expect(page.nextPageToken).toBe('n')
    expect(page.files).toEqual([
      { id: '1', name: 'a.docx', mimeType: 'x', modifiedTime: 't', size: 12 },
    ])
    const init = (fetchImpl as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock
      .calls[0][1]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })

  it('escapes quotes in the search term and only asks for openable types', () => {
    const q = openableFilesQuery("it's")
    expect(q).toContain("name contains 'it\\'s'")
    expect(q).toContain("mimeType = 'application/vnd.google-apps.document'")
    expect(q).toContain("mimeType = 'application/pdf'")
    expect(q).toContain('trashed = false')
  })

  it('exports Google-native documents and downloads binaries as-is', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: unknown) => {
      urls.push(String(url))
      return new Response('bytes', { status: 200 })
    }) as unknown as typeof fetch
    const dir = scratch()
    await downloadDriveFile(
      'tok',
      { id: 'g1', mimeType: 'application/vnd.google-apps.document' },
      join(dir, 'a.docx'),
      fetchImpl,
    )
    await downloadDriveFile(
      'tok',
      { id: 'b1', mimeType: 'application/pdf' },
      join(dir, 'b.pdf'),
      fetchImpl,
    )
    expect(readFileSync(join(dir, 'a.docx'), 'utf8')).toBe('bytes')
    expect(urls[0]).toContain(
      '/files/g1/export?mimeType=application%2Fvnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(urls[1]).toContain('/files/b1?alt=media')
  })

  it('names cached files with the export extension for Google-native types', () => {
    expect(
      localNameFor({ name: 'Plan', mimeType: 'application/vnd.google-apps.spreadsheet' }),
    ).toBe('Plan.xlsx')
    expect(
      localNameFor({ name: 'Deck.pptx', mimeType: 'application/vnd.google-apps.presentation' }),
    ).toBe('Deck.pptx')
    expect(localNameFor({ name: 'a/b:c.pdf', mimeType: 'application/pdf' })).toBe('a_b_c.pdf')
  })

  it('uploads new content with a media PATCH and creates files with a multipart POST', async () => {
    const dir = scratch()
    const local = join(dir, 'note.md')
    writeFileSync(local, '# hi')
    const seen: { url: string; init: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init: init! })
      return jsonResponse({
        id: 'new',
        name: 'note.md',
        mimeType: 'text/markdown',
        modifiedTime: 't',
      })
    }) as unknown as typeof fetch
    const updated = await updateDriveFileContent(
      'tok',
      { id: 'f1', mimeType: 'text/markdown' },
      local,
      fetchImpl,
    )
    expect(updated.id).toBe('new')
    expect(seen[0].url).toContain('/upload/drive/v3/files/f1?uploadType=media')
    expect(seen[0].init.method).toBe('PATCH')
    expect((seen[0].init.headers as Record<string, string>)['content-type']).toBe('text/markdown')

    await createDriveFile('tok', { localPath: local, parents: ['folder'] }, fetchImpl)
    expect(seen[1].url).toContain('/upload/drive/v3/files?uploadType=multipart')
    const body = (seen[1].init.body as Buffer).toString()
    expect(body).toContain('"name":"note.md"')
    expect(body).toContain('"parents":["folder"]')
    expect(body).toContain('# hi')
  })

  it('surfaces Google error messages and marks 401 as re-auth', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: { message: 'Invalid Credentials' } }, 401)) as typeof fetch
    const err = await listDriveFiles('tok', {}, fetchImpl).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleDriveError)
    expect((err as GoogleDriveError).status).toBe(401)
    expect((err as GoogleDriveError).reauth).toBe(true)
    expect((err as GoogleDriveError).message).toBe('Google Drive: Invalid Credentials')
  })
})
