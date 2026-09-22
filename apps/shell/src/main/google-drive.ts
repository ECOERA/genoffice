/**
 * Google Drive for the shell: sign-in state, the local cache of opened Drive
 * files, and the write-back that uploads a cached file after the editor saves
 * it. Everything Electron-specific (paths, safeStorage, the browser, opening
 * a tab, pushing events to the renderer) comes in through `GoogleDriveDeps`,
 * so the service is unit-tested with temp dirs and a fake fetch.
 *
 * Write-back does not need a hook in the editors: the cache keeps one folder
 * per Drive file, that folder is watched with fs.watch, and a save (plain,
 * autosave, or atomic temp+rename) uploads once the writes settle.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { readAppSettings, writeAppSettings } from './app-settings'
import {
  GoogleDriveError,
  GOOGLE_EXPORTS,
  createDriveFile,
  downloadDriveFile,
  fetchUserInfo,
  getDriveFile,
  listDriveFiles,
  localNameFor,
  loopbackLogin,
  openableFilesQuery,
  refreshAccessToken,
  revokeToken,
  updateDriveFileContent,
  type DriveFile,
  type FetchLike,
  type GoogleOAuthConfig,
  type GoogleTokens,
  type GoogleUserInfo,
  SIGN_IN_SCOPES,
} from './google-drive-api'
import type {
  GoogleDriveConfig,
  GoogleDriveFileEntry,
  GoogleDriveFileKind,
  GoogleDriveListPage,
  GoogleDriveStatus,
  GoogleDriveSyncEvent,
} from '../shared/home-api'

export const GOOGLE_CLIENT_ID_KEY = 'googleClientId'
export const GOOGLE_CLIENT_SECRET_KEY = 'googleClientSecret'

/** Quiet period after the last write before a cached file is uploaded. */
export const SYNC_SETTLE_MS = 1500
/**
 * Safety net under fs.watch: macOS coalesces a write that lands right after
 * the download into the pre-watch rename and never delivers it, so bound
 * files are also stat-polled at a low rate.
 */
export const SYNC_POLL_MS = 30_000

export interface GoogleDriveDeps {
  /** Electron userData; the service keeps everything under <userData>/google-drive. */
  userData: string
  /** userData/app-settings.json, where the OAuth client can be configured. */
  settingsPath: string
  /** OAuth client injected at build time (packaged builds only). */
  buildConfig?: { clientId?: unknown; clientSecret?: unknown } | null
  env?: NodeJS.ProcessEnv
  openExternal: (url: string) => Promise<void> | void
  /** Routes a local path into the right editor tab; false when nothing opened. */
  openDocument: (path: string) => boolean
  /** Pushes write-back progress to the Home renderer. */
  emit: (event: GoogleDriveSyncEvent) => void
  /** OS-keychain-backed protection for the stored tokens (Electron safeStorage). */
  protect?: { encrypt: (plain: string) => Buffer; decrypt: (data: Buffer) => string }
  fetchImpl?: FetchLike
  settleMs?: number
  pollMs?: number
  log?: (message: string) => void
}

interface AuthStore {
  v: 1
  enc: boolean
  /** base64 of the encrypted (or plain UTF-8) JSON `{ tokens, user }`. */
  data: string
}

interface CacheEntry {
  fileId: string
  name: string
  mimeType: string
  /** Drive's modifiedTime after the last download/upload. */
  modifiedTime: string
  /** Local mtime + size after the last download/upload; any difference means unsynced edits. */
  syncedMtimeMs: number
  syncedSize: number
  lastSyncMs: number
  webViewLink?: string
}

interface CacheIndex {
  v: 1
  /** keyed by the absolute local path */
  files: Record<string, CacheEntry>
}

const KIND_BY_EXT: Record<string, GoogleDriveFileKind> = {
  '.docx': 'docs',
  '.xlsx': 'sheets',
  '.xlsm': 'sheets',
  '.xls': 'sheets',
  '.csv': 'sheets',
  '.pptx': 'slides',
  '.pdf': 'pdf',
  '.md': 'markdown',
  '.markdown': 'markdown',
}

export function fileKindFor(file: Pick<DriveFile, 'name' | 'mimeType'>): GoogleDriveFileKind {
  const exp = GOOGLE_EXPORTS[file.mimeType]
  const ext = exp ? exp.ext : extname(file.name).toLowerCase()
  return KIND_BY_EXT[ext] ?? 'other'
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Exact comparison: the same filesystem reads back the recorded mtime bit for bit. */
function hasUnsyncedEdits(
  path: string,
  entry: Pick<CacheEntry, 'syncedMtimeMs' | 'syncedSize'>,
): boolean {
  const st = statSync(path)
  return st.mtimeMs !== entry.syncedMtimeMs || st.size !== entry.syncedSize
}

export class GoogleDriveService {
  private readonly deps: GoogleDriveDeps
  private readonly root: string
  private readonly filesDir: string
  private readonly authPath: string
  private readonly indexPath: string
  private readonly fetchImpl: FetchLike
  private tokens: GoogleTokens | null = null
  private user: GoogleUserInfo | null = null
  private index: CacheIndex
  private loginAbort: AbortController | null = null
  private refreshing: Promise<string> | null = null
  private readonly watchers = new Map<string, { watcher: FSWatcher; paths: Set<string> }>()
  private readonly pending = new Map<string, NodeJS.Timeout>()
  private readonly uploading = new Map<string, Promise<void>>()
  private readonly dirty = new Set<string>()
  private poll: NodeJS.Timeout | null = null

  constructor(deps: GoogleDriveDeps) {
    this.deps = deps
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.root = join(deps.userData, 'google-drive')
    this.filesDir = join(this.root, 'files')
    this.authPath = join(this.root, 'auth.json')
    this.indexPath = join(this.root, 'index.json')
    this.index = this.readIndex()
    this.loadAuth()
    if (this.tokens) this.armAllWatchers()
  }

  // ── configuration ──────────────────────────────────────

  getConfig(): GoogleDriveConfig {
    const settings = readAppSettings(this.deps.settingsPath)
    const fromSettings = {
      clientId: asString(settings[GOOGLE_CLIENT_ID_KEY]),
      clientSecret: asString(settings[GOOGLE_CLIENT_SECRET_KEY]),
    }
    if (fromSettings.clientId) return { ...fromSettings, source: 'settings' }
    const env = this.deps.env ?? process.env
    const envId = asString(env.DUNEOFFICE_GOOGLE_CLIENT_ID)
    if (envId) {
      return {
        clientId: envId,
        clientSecret: asString(env.DUNEOFFICE_GOOGLE_CLIENT_SECRET),
        source: 'env',
      }
    }
    const buildId = asString(this.deps.buildConfig?.clientId)
    if (buildId) {
      return {
        clientId: buildId,
        clientSecret: asString(this.deps.buildConfig?.clientSecret),
        source: 'build',
      }
    }
    return { clientId: '', clientSecret: '', source: 'none' }
  }

  setConfig(input: { clientId?: unknown; clientSecret?: unknown }): GoogleDriveConfig {
    const clientId = asString(input.clientId)
    const clientSecret = asString(input.clientSecret)
    writeAppSettings(this.deps.settingsPath, {
      [GOOGLE_CLIENT_ID_KEY]: clientId || undefined,
      [GOOGLE_CLIENT_SECRET_KEY]: clientSecret || undefined,
    })
    return this.getConfig()
  }

  private oauthConfig(): GoogleOAuthConfig {
    const cfg = this.getConfig()
    if (!cfg.clientId)
      throw new GoogleDriveError(
        'Google Drive is not configured: add an OAuth client id in Settings.',
      )
    return { clientId: cfg.clientId, clientSecret: cfg.clientSecret || undefined }
  }

  // ── sign-in state ──────────────────────────────────────

  status(): GoogleDriveStatus {
    const configured = Boolean(this.getConfig().clientId)
    if (!this.tokens || !this.user) return { configured, signedIn: false }
    return {
      configured,
      signedIn: true,
      email: this.user.email,
      name: this.user.name,
      picture: this.user.picture,
    }
  }

  async login(): Promise<GoogleDriveStatus> {
    const cfg = this.oauthConfig()
    this.loginAbort?.abort()
    const abort = new AbortController()
    this.loginAbort = abort
    try {
      const tokens = await loopbackLogin(cfg, {
        openExternal: this.deps.openExternal,
        signal: abort.signal,
        fetchImpl: this.fetchImpl,
        loginHint: this.user?.email,
        scopes: SIGN_IN_SCOPES,
      })
      const user = await fetchUserInfo(tokens.accessToken, this.fetchImpl)
      this.tokens = tokens
      this.user = user
      this.saveAuth()
      this.armAllWatchers()
      return this.status()
    } finally {
      if (this.loginAbort === abort) this.loginAbort = null
    }
  }

  cancelLogin(): void {
    this.loginAbort?.abort()
    this.loginAbort = null
  }

  async logout(): Promise<void> {
    this.cancelLogin()
    const token = this.tokens?.refreshToken ?? this.tokens?.accessToken
    this.tokens = null
    this.user = null
    this.disarmAllWatchers()
    rmSync(this.authPath, { force: true })
    if (token) await revokeToken(token, this.fetchImpl)
  }

  /** Valid access token for the other Google APIs (mail, calendar); throws when signed out. */
  async token(): Promise<string> {
    return this.accessToken()
  }

  /** Scopes the stored grant covers (empty when signed out or unknown). */
  grantedScopes(): string[] {
    return this.tokens?.scope ? this.tokens.scope.split(/\s+/).filter(Boolean) : []
  }

  /** Valid access token, refreshed when within a minute of expiry. */
  private async accessToken(): Promise<string> {
    const tokens = this.tokens
    if (!tokens) throw new GoogleDriveError('Not signed in to Google Drive.', 0, true)
    if (Date.now() < tokens.expiresAt) return tokens.accessToken
    if (!this.refreshing) {
      this.refreshing = refreshAccessToken(this.oauthConfig(), tokens, this.fetchImpl)
        .then((next) => {
          this.tokens = next
          this.saveAuth()
          return next.accessToken
        })
        .catch((err: unknown) => {
          if (err instanceof GoogleDriveError && err.reauth) {
            // the refresh token was revoked or expired: back to signed-out
            this.tokens = null
            this.user = null
            this.disarmAllWatchers()
            rmSync(this.authPath, { force: true })
          }
          throw err
        })
        .finally(() => {
          this.refreshing = null
        })
    }
    return this.refreshing
  }

  // ── listing and opening ────────────────────────────────

  async list(opts: { search?: string; pageToken?: string } = {}): Promise<GoogleDriveListPage> {
    const token = await this.accessToken()
    const page = await listDriveFiles(
      token,
      { query: openableFilesQuery(opts.search), pageToken: opts.pageToken },
      this.fetchImpl,
    )
    return { files: page.files.map((f) => this.toEntry(f)), nextPageToken: page.nextPageToken }
  }

  /**
   * Downloads the file into its cache folder (unless the cached copy is
   * current or carries unsynced edits) and opens it in the matching editor.
   */
  async open(fileId: string): Promise<{ path: string }> {
    const token = await this.accessToken()
    const file = await getDriveFile(token, fileId, this.fetchImpl)
    const dir = join(this.filesDir, fileId)
    const path = join(dir, localNameFor(file))
    const existing = this.entryFor(fileId)
    const cached = existing !== null && existsSync(path)
    const hasLocalEdits = cached && hasUnsyncedEdits(path, existing)
    const remoteUnchanged = cached && existing.modifiedTime === file.modifiedTime
    if (!(hasLocalEdits || remoteUnchanged)) {
      mkdirSync(dir, { recursive: true })
      // a stale copy under a different name (renamed on Drive) is replaced
      for (const [p] of Object.entries(this.index.files)) {
        if (dirname(p) === dir && p !== path) {
          rmSync(p, { force: true })
          delete this.index.files[p]
        }
      }
      const part = `${path}.part`
      await downloadDriveFile(token, file, part, this.fetchImpl)
      renameSync(part, path)
      this.remember(path, file)
    } else if (existing) {
      // keep the newest metadata (name/link) without touching the sync marker
      this.index.files[path] = { ...existing, name: file.name, webViewLink: file.webViewLink }
      this.writeIndex()
    }
    this.armWatcher(path)
    if (!this.deps.openDocument(path)) {
      throw new GoogleDriveError(`DuneOffice cannot open "${file.name}".`)
    }
    return { path }
  }

  /** Creates a new Drive file from a local document and keeps it in sync from then on. */
  async upload(localPath: string): Promise<GoogleDriveFileEntry> {
    if (!existsSync(localPath)) throw new GoogleDriveError('The file no longer exists.')
    const token = await this.accessToken()
    const file = await createDriveFile(token, { localPath }, this.fetchImpl)
    this.remember(localPath, file)
    this.armWatcher(localPath)
    return this.toEntry(file)
  }

  /** The cache entry a local path is bound to, if any. */
  boundFile(localPath: string): { fileId: string; name: string } | null {
    const entry = this.index.files[localPath]
    return entry ? { fileId: entry.fileId, name: entry.name } : null
  }

  /** Uploads every cached file with unsynced edits now (used at quit). */
  async flush(): Promise<void> {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    const paths = [...this.dirty]
    this.dirty.clear()
    await Promise.all(paths.map((p) => this.uploadNow(p)))
    await Promise.all([...this.uploading.values()])
  }

  dispose(): void {
    this.cancelLogin()
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.disarmAllWatchers()
  }

  // ── write-back ─────────────────────────────────────────

  private armAllWatchers(): void {
    for (const path of Object.keys(this.index.files)) {
      if (existsSync(path)) this.armWatcher(path)
    }
  }

  private disarmAllWatchers(): void {
    for (const { watcher } of this.watchers.values()) watcher.close()
    this.watchers.clear()
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  /** Schedules an upload for every bound file whose edits fs.watch did not report. */
  private pollDirty(): void {
    for (const [path, entry] of Object.entries(this.index.files)) {
      if (this.pending.has(path) || this.uploading.has(path)) continue
      if (existsSync(path) && hasUnsyncedEdits(path, entry)) this.scheduleUpload(path)
    }
  }

  private armWatcher(path: string): void {
    if (!this.tokens) return
    if (!this.poll) {
      this.poll = setInterval(() => this.pollDirty(), this.deps.pollMs ?? SYNC_POLL_MS)
      this.poll.unref?.()
    }
    const dir = dirname(path)
    let entry = this.watchers.get(dir)
    if (!entry) {
      let watcher: FSWatcher
      try {
        watcher = watch(dir, { persistent: false }, (_event, filename) => {
          if (!filename) return
          const changed = join(dir, String(filename))
          if (this.watchers.get(dir)?.paths.has(changed)) this.scheduleUpload(changed)
        })
      } catch (err) {
        this.deps.log?.(`google-drive: cannot watch ${dir}: ${(err as Error).message}`)
        return
      }
      watcher.on('error', () => this.watchers.delete(dir))
      entry = { watcher, paths: new Set() }
      this.watchers.set(dir, entry)
    }
    entry.paths.add(path)
  }

  private scheduleUpload(path: string): void {
    const existing = this.pending.get(path)
    if (existing) clearTimeout(existing)
    this.dirty.add(path)
    this.pending.set(
      path,
      setTimeout(() => {
        this.pending.delete(path)
        this.dirty.delete(path)
        void this.uploadNow(path)
      }, this.deps.settleMs ?? SYNC_SETTLE_MS),
    )
  }

  private uploadNow(path: string): Promise<void> {
    const inFlight = this.uploading.get(path)
    if (inFlight) {
      // changes during an upload: run again once it finishes
      const again = inFlight.then(() => this.uploadNow(path))
      this.uploading.set(path, again)
      return again
    }
    const run = this.uploadOnce(path).finally(() => {
      if (this.uploading.get(path) === run) this.uploading.delete(path)
    })
    this.uploading.set(path, run)
    return run
  }

  private async uploadOnce(path: string): Promise<void> {
    const entry = this.index.files[path]
    if (!entry || !existsSync(path)) return
    if (!hasUnsyncedEdits(path, entry)) return
    const base = { fileId: entry.fileId, path, name: entry.name, atMs: Date.now() }
    this.deps.emit({ ...base, phase: 'uploading' })
    try {
      // stat before the upload: a write that lands during it stays "unsynced"
      const st = statSync(path)
      const token = await this.accessToken()
      const updated = await updateDriveFileContent(
        token,
        { id: entry.fileId, mimeType: entry.mimeType },
        path,
        this.fetchImpl,
      )
      this.index.files[path] = {
        ...entry,
        modifiedTime: updated.modifiedTime || entry.modifiedTime,
        syncedMtimeMs: st.mtimeMs,
        syncedSize: st.size,
        lastSyncMs: Date.now(),
      }
      this.writeIndex()
      this.deps.emit({ ...base, phase: 'done', atMs: Date.now() })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.log?.(`google-drive: upload of ${basename(path)} failed: ${message}`)
      this.deps.emit({ ...base, phase: 'error', error: message, atMs: Date.now() })
    }
  }

  // ── persistence ────────────────────────────────────────

  private entryFor(fileId: string): CacheEntry | null {
    for (const entry of Object.values(this.index.files)) if (entry.fileId === fileId) return entry
    return null
  }

  private remember(path: string, file: DriveFile): void {
    const st = statSync(path)
    this.index.files[path] = {
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      syncedMtimeMs: st.mtimeMs,
      syncedSize: st.size,
      lastSyncMs: Date.now(),
      webViewLink: file.webViewLink,
    }
    this.writeIndex()
  }

  private toEntry(file: DriveFile): GoogleDriveFileEntry {
    const exp = GOOGLE_EXPORTS[file.mimeType]
    const cached = this.entryFor(file.id)
    const cachedPath = cached
      ? Object.keys(this.index.files).find((p) => this.index.files[p] === cached)
      : undefined
    return {
      id: file.id,
      name: file.name,
      kind: fileKindFor(file),
      ext: (exp ? exp.ext : extname(file.name).toLowerCase()).replace(/^\./, ''),
      mimeType: file.mimeType,
      googleNative: Boolean(exp),
      modifiedMs: Date.parse(file.modifiedTime) || 0,
      size: file.size,
      webViewLink: file.webViewLink,
      cachedPath,
      syncedMs: cached?.lastSyncMs,
    }
  }

  private readIndex(): CacheIndex {
    try {
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf8')) as CacheIndex
      if (raw && raw.v === 1 && raw.files && typeof raw.files === 'object') return raw
    } catch {
      // missing or corrupt: start empty
    }
    return { v: 1, files: {} }
  }

  private writeIndex(): void {
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2))
  }

  private loadAuth(): void {
    try {
      const store = JSON.parse(readFileSync(this.authPath, 'utf8')) as AuthStore
      if (!store || store.v !== 1 || typeof store.data !== 'string') return
      const buf = Buffer.from(store.data, 'base64')
      const json = store.enc
        ? this.deps.protect
          ? this.deps.protect.decrypt(buf)
          : ''
        : buf.toString('utf8')
      if (!json) return
      const parsed = JSON.parse(json) as { tokens?: GoogleTokens; user?: GoogleUserInfo }
      if (parsed.tokens?.accessToken && parsed.user?.email) {
        this.tokens = parsed.tokens
        this.user = parsed.user
      }
    } catch {
      // unreadable store (other machine's keychain, corrupt file): signed out
    }
  }

  private saveAuth(): void {
    if (!this.tokens || !this.user) return
    mkdirSync(this.root, { recursive: true })
    const json = JSON.stringify({ tokens: this.tokens, user: this.user })
    const store: AuthStore = this.deps.protect
      ? { v: 1, enc: true, data: this.deps.protect.encrypt(json).toString('base64') }
      : { v: 1, enc: false, data: Buffer.from(json, 'utf8').toString('base64') }
    writeFileSync(this.authPath, JSON.stringify(store), { mode: 0o600 })
  }
}
