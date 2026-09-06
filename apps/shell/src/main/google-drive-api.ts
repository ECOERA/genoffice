/**
 * Google Drive: OAuth 2.0 for installed apps (PKCE + loopback redirect) and
 * the handful of Drive v3 REST calls the shell needs. Pure Node — no Electron
 * imports — so it is unit-testable with a fake `fetch`; the Electron-facing
 * glue (token storage, IPC, tab opening) lives in google-drive.ts.
 *
 * Google's "Desktop app" OAuth client type: the client secret is not treated
 * as a secret by Google for this client type (it ships inside the app), PKCE
 * is what protects the code exchange, and the redirect goes to a loopback
 * http server the app opens on an ephemeral 127.0.0.1 port.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { basename, extname } from 'node:path'

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret?: string
}

export interface GoogleTokens {
  accessToken: string
  /** Absent when Google did not issue one (re-consent without `prompt=consent`). */
  refreshToken?: string
  /** Unix ms; refresh a minute before this. */
  expiresAt: number
  scope: string
}

export interface GoogleUserInfo {
  email: string
  name?: string
  picture?: string
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  size?: number
  parents?: string[]
  webViewLink?: string
  iconLink?: string
}

export interface DriveListPage {
  files: DriveFile[]
  nextPageToken?: string
}

export class GoogleDriveError extends Error {
  /** HTTP status when the failure came from Google, 0 for network/local errors. */
  readonly status: number
  /** True when the tokens are no longer usable and the user must sign in again. */
  readonly reauth: boolean
  constructor(message: string, status = 0, reauth = false) {
    super(message)
    this.name = 'GoogleDriveError'
    this.status = status
    this.reauth = reauth
  }
}

export type FetchLike = typeof fetch

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

/**
 * Full Drive access is a "restricted" scope: it is the only way to list the
 * user's existing files without the browser-only Picker. See
 * docs/google-drive.md for what that means for the OAuth consent screen.
 */
export const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

export const DRIVE_FIELDS = 'id,name,mimeType,modifiedTime,size,parents,webViewLink,iconLink'

/** Google-native types and the Office format the shell opens them as. */
export const GOOGLE_EXPORTS: Record<string, { mimeType: string; ext: string }> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: '.pptx',
  },
}

/** Binary types the editors open directly, keyed by extension. */
export const OPENABLE_MIME_TYPES: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
}

/** Drive query listing everything the editors can open, newest first. */
export function openableFilesQuery(search?: string): string {
  const types = [...Object.keys(GOOGLE_EXPORTS), ...new Set(Object.values(OPENABLE_MIME_TYPES))]
  const parts = [`trashed = false`, `(${types.map((t) => `mimeType = '${t}'`).join(' or ')})`]
  const needle = search?.trim()
  if (needle) parts.push(`name contains '${needle.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
  return parts.join(' and ')
}

/** Local file name a Drive file is cached as (Google-native types get the export extension). */
export function localNameFor(file: Pick<DriveFile, 'name' | 'mimeType'>): string {
  const exp = GOOGLE_EXPORTS[file.mimeType]
  const printable = Array.from(file.name)
    .filter((c) => c.charCodeAt(0) >= 32)
    .join('')
  const safe = printable.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Untitled'
  if (!exp) return safe
  return extname(safe).toLowerCase() === exp.ext ? safe : `${safe}${exp.ext}`
}

/** The upload MIME type for a local path, by extension. */
export function mimeTypeForPath(path: string): string {
  return OPENABLE_MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// OAuth

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function buildAuthUrl(
  cfg: GoogleOAuthConfig,
  opts: {
    redirectUri: string
    state: string
    challenge: string
    scopes?: string[]
    loginHint?: string
  },
): string {
  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', cfg.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', (opts.scopes ?? DRIVE_SCOPES).join(' '))
  url.searchParams.set('state', opts.state)
  url.searchParams.set('code_challenge', opts.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('access_type', 'offline')
  // Force the consent screen so Google issues a refresh token every time we
  // sign in (it only does so on the first grant otherwise).
  url.searchParams.set('prompt', 'consent')
  if (opts.loginHint) url.searchParams.set('login_hint', opts.loginHint)
  return url.toString()
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  error?: string
  error_description?: string
}

async function tokenRequest(
  params: Record<string, string>,
  fetchImpl: FetchLike,
  previous?: GoogleTokens,
): Promise<GoogleTokens> {
  let res: Response
  try {
    res = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    })
  } catch (err) {
    throw new GoogleDriveError(`Google token request failed: ${(err as Error).message}`)
  }
  const body = (await res.json().catch(() => ({}))) as TokenResponse
  if (!res.ok || !body.access_token) {
    const code = body.error ?? `HTTP ${res.status}`
    const reauth = res.status === 400 || res.status === 401 || code === 'invalid_grant'
    throw new GoogleDriveError(
      `Google sign-in failed: ${code}${body.error_description ? ` (${body.error_description})` : ''}`,
      res.status,
      reauth,
    )
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + Math.max(0, body.expires_in - 60) * 1000,
    scope: body.scope ?? previous?.scope ?? '',
  }
}

export function exchangeCode(
  cfg: GoogleOAuthConfig,
  opts: { code: string; redirectUri: string; verifier: string },
  fetchImpl: FetchLike = fetch,
): Promise<GoogleTokens> {
  return tokenRequest(
    {
      client_id: cfg.clientId,
      ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
      code: opts.code,
      code_verifier: opts.verifier,
      grant_type: 'authorization_code',
      redirect_uri: opts.redirectUri,
    },
    fetchImpl,
  )
}

export function refreshAccessToken(
  cfg: GoogleOAuthConfig,
  tokens: GoogleTokens,
  fetchImpl: FetchLike = fetch,
): Promise<GoogleTokens> {
  if (!tokens.refreshToken) {
    return Promise.reject(new GoogleDriveError('No refresh token; sign in again.', 0, true))
  }
  return tokenRequest(
    {
      client_id: cfg.clientId,
      ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
    },
    fetchImpl,
    tokens,
  )
}

/** Best-effort server-side revoke; never throws. */
export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<void> {
  try {
    await fetchImpl(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: 'POST' })
  } catch {
    // offline: the local copy is deleted regardless
  }
}

export interface LoopbackLoginOptions {
  /** Opens the URL in the user's browser. */
  openExternal: (url: string) => Promise<void> | void
  /** Aborts the wait (window closed, user cancelled). */
  signal?: AbortSignal
  timeoutMs?: number
  scopes?: string[]
  loginHint?: string
  /** HTML shown in the browser tab after the redirect. */
  successHtml?: string
  fetchImpl?: FetchLike
}

/**
 * Runs the full installed-app flow: loopback server on an ephemeral port,
 * browser hand-off, code exchange with PKCE. Resolves with the tokens.
 */
export function loopbackLogin(
  cfg: GoogleOAuthConfig,
  opts: LoopbackLoginOptions,
): Promise<GoogleTokens> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const { verifier, challenge } = createPkce()
  const state = base64url(randomBytes(24))
  const html = (title: string, body: string) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:48px;text-align:center"><h1>${title}</h1><p>${body}</p></body>`
  const successHtml =
    opts.successHtml ??
    html('Signed in to DuneOffice', 'You can close this tab and return to the app.')

  return new Promise<GoogleTokens>((resolve, reject) => {
    let server: Server | null = null
    let settled = false
    const timer = setTimeout(
      () => finish(new GoogleDriveError('Google sign-in timed out.')),
      opts.timeoutMs ?? 5 * 60_000,
    )
    const onAbort = () => finish(new GoogleDriveError('Google sign-in cancelled.'))
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    function finish(err: Error | null, tokens?: GoogleTokens) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      server?.close()
      if (err) reject(err)
      else resolve(tokens!)
    }

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/oauth2/callback') {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (error || !code || url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        res.end(html('Sign-in failed', error ?? 'Missing or mismatched authorization code.'))
        finish(new GoogleDriveError(`Google sign-in failed: ${error ?? 'invalid callback'}`))
        return
      }
      const redirectUri = `http://127.0.0.1:${(server!.address() as { port: number }).port}/oauth2/callback`
      exchangeCode(cfg, { code, redirectUri, verifier }, fetchImpl).then(
        (tokens) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(successHtml)
          finish(null, tokens)
        },
        (err: Error) => {
          res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
          res.end(html('Sign-in failed', err.message))
          finish(err)
        },
      )
    })
    server.on('error', (err) => finish(new GoogleDriveError(`Loopback server: ${err.message}`)))
    server.listen(0, '127.0.0.1', () => {
      const port = (server!.address() as { port: number }).port
      const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`
      const authUrl = buildAuthUrl(cfg, {
        redirectUri,
        state,
        challenge,
        scopes: opts.scopes,
        loginHint: opts.loginHint,
      })
      Promise.resolve(opts.openExternal(authUrl)).catch((err: Error) =>
        finish(new GoogleDriveError(`Could not open the browser: ${err.message}`)),
      )
    })
  })
}

// ---------------------------------------------------------------------------
// Drive REST

async function driveFetch(
  accessToken: string,
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<Response> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        authorization: `Bearer ${accessToken}`,
      },
    })
  } catch (err) {
    throw new GoogleDriveError(`Google Drive request failed: ${(err as Error).message}`)
  }
  if (res.ok) return res
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    detail = body.error?.message ?? ''
  } catch {
    // non-JSON error body
  }
  throw new GoogleDriveError(
    `Google Drive: ${detail || res.statusText || `HTTP ${res.status}`}`,
    res.status,
    res.status === 401,
  )
}

export async function fetchUserInfo(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<GoogleUserInfo> {
  const res = await driveFetch(accessToken, USERINFO_ENDPOINT, {}, fetchImpl)
  const body = (await res.json()) as { email?: string; name?: string; picture?: string }
  if (!body.email) throw new GoogleDriveError('Google did not return an account email.')
  return { email: body.email, name: body.name, picture: body.picture }
}

function normalizeFile(raw: Record<string, unknown>): DriveFile {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    mimeType: String(raw.mimeType ?? ''),
    modifiedTime: String(raw.modifiedTime ?? ''),
    size: raw.size === undefined ? undefined : Number(raw.size),
    parents: Array.isArray(raw.parents) ? (raw.parents as string[]) : undefined,
    webViewLink: raw.webViewLink === undefined ? undefined : String(raw.webViewLink),
    iconLink: raw.iconLink === undefined ? undefined : String(raw.iconLink),
  }
}

export async function listDriveFiles(
  accessToken: string,
  opts: { query?: string; pageSize?: number; pageToken?: string; orderBy?: string } = {},
  fetchImpl: FetchLike = fetch,
): Promise<DriveListPage> {
  const url = new URL(`${DRIVE_API}/files`)
  url.searchParams.set('q', opts.query ?? openableFilesQuery())
  url.searchParams.set('pageSize', String(opts.pageSize ?? 50))
  url.searchParams.set('orderBy', opts.orderBy ?? 'modifiedTime desc')
  url.searchParams.set('fields', `nextPageToken,files(${DRIVE_FIELDS})`)
  url.searchParams.set('supportsAllDrives', 'true')
  url.searchParams.set('includeItemsFromAllDrives', 'true')
  if (opts.pageToken) url.searchParams.set('pageToken', opts.pageToken)
  const res = await driveFetch(accessToken, url.toString(), {}, fetchImpl)
  const body = (await res.json()) as { files?: Record<string, unknown>[]; nextPageToken?: string }
  return { files: (body.files ?? []).map(normalizeFile), nextPageToken: body.nextPageToken }
}

export async function getDriveFile(
  accessToken: string,
  fileId: string,
  fetchImpl: FetchLike = fetch,
): Promise<DriveFile> {
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(DRIVE_FIELDS)}&supportsAllDrives=true`
  const res = await driveFetch(accessToken, url, {}, fetchImpl)
  return normalizeFile((await res.json()) as Record<string, unknown>)
}

/**
 * Downloads a file to `dest`. Google-native documents are exported to their
 * Office format (Drive caps exports at 10 MB).
 */
export async function downloadDriveFile(
  accessToken: string,
  file: Pick<DriveFile, 'id' | 'mimeType'>,
  dest: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const exp = GOOGLE_EXPORTS[file.mimeType]
  const url = exp
    ? `${DRIVE_API}/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exp.mimeType)}`
    : `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`
  const res = await driveFetch(accessToken, url, {}, fetchImpl)
  if (!res.body) throw new GoogleDriveError('Empty response body from Google Drive.')
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest))
}

/** Replaces the content of an existing Drive file with a local file (media upload). */
export async function updateDriveFileContent(
  accessToken: string,
  file: Pick<DriveFile, 'id' | 'mimeType'>,
  localPath: string,
  fetchImpl: FetchLike = fetch,
): Promise<DriveFile> {
  const data = await readFile(localPath)
  const exp = GOOGLE_EXPORTS[file.mimeType]
  // Uploading Office bytes to a Google-native file converts them back into
  // that native type; a plain binary keeps its own MIME type.
  const contentType = exp ? exp.mimeType : mimeTypeForPath(localPath)
  const url = `${DRIVE_UPLOAD}/files/${encodeURIComponent(file.id)}?uploadType=media&supportsAllDrives=true&fields=${encodeURIComponent(DRIVE_FIELDS)}`
  const res = await driveFetch(
    accessToken,
    url,
    { method: 'PATCH', headers: { 'content-type': contentType }, body: data },
    fetchImpl,
  )
  return normalizeFile((await res.json()) as Record<string, unknown>)
}

/** Creates a new Drive file from a local file (multipart upload). */
export async function createDriveFile(
  accessToken: string,
  opts: { localPath: string; name?: string; parents?: string[] },
  fetchImpl: FetchLike = fetch,
): Promise<DriveFile> {
  const data = await readFile(opts.localPath)
  const mimeType = mimeTypeForPath(opts.localPath)
  const metadata = {
    name: opts.name ?? basename(opts.localPath),
    mimeType,
    ...(opts.parents?.length ? { parents: opts.parents } : {}),
  }
  const boundary = `duneoffice-${randomBytes(12).toString('hex')}`
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ])
  const url = `${DRIVE_UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(DRIVE_FIELDS)}`
  const res = await driveFetch(
    accessToken,
    url,
    {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body,
    },
    fetchImpl,
  )
  return normalizeFile((await res.json()) as Record<string, unknown>)
}
