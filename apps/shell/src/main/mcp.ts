/**
 * Electron side of the MCP integration: one McpManager for the app, the
 * permission dialog, the persisted "always allow" list, the loopback image
 * store, the built-in servers the app ships, and the IPC that every editor's
 * preload bridge (window.mcpBridge) and the Settings pane use. The protocol
 * client itself lives in @genoffice/mcp-client and knows nothing about
 * Electron.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, webContents } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MCP_CHANNELS } from '@genoffice/agent-core'
import { fetchWithSsrfGuard, registerTrustedLocalOrigin } from '@genoffice/electron-utils'
import {
  AI_PROVIDERS,
  activeProvider,
  chatForProvider,
  type AiProviderId,
  type AiSettings,
} from '@genoffice/ai-provider'
import { readFileSync } from 'node:fs'
import {
  McpManager,
  defaultMcpConfigPath,
  ensureMcpConfigFile,
  type McpBuiltinSpec,
  type McpPermissionDecision,
  type McpRemoteSpec,
  type McpServerSpec,
  type McpServerStatus,
  type McpStdioSpec,
} from '@genoffice/mcp-client'
import { readAppSettings, writeAppSettings } from './app-settings'
import { Brand, createBrandServer } from './hosted/brand'
import { Citer, createCiteServer } from './hosted/cite'
import { createDiagramServer } from './hosted/diagram'
import { createDigestServer, Digest } from './hosted/digest'
import { createGoogleServer, GoogleTools } from './hosted/google'
import { createDataServer, DataConnectors } from './hosted/data'
import { createKbServer, KnowledgeBase } from './hosted/kb'
import { createSandboxServer, Sandbox } from './hosted/sandbox'
import { createTranscribeServer, Transcriber } from './hosted/transcribe'
import { closeDiagramWindow, renderMermaid } from './diagram-window'
import { McpHost } from './mcp-host'
import { startMcpImageStore, type McpImageStore } from './mcp-images'
import { HOME_CHANNELS, type McpStatusInfo } from '../shared/home-api'

const ALLOWED_KEY = 'mcpAllowedServers'

export interface McpDialogText {
  title: string
  body: (server: string, tool: string) => string
  always: string
  once: string
  deny: string
}

export interface McpHostOptions {
  settingsPath: () => string
  /** localized dialog strings, resolved at prompt time so a language switch applies */
  dialogText: () => McpDialogText
  /** the Google sign-in shared with Drive, for the mail/calendar server */
  google?: { token: () => Promise<string>; scopes: () => string[] }
  log?: (message: string) => void
}

let manager: McpManager | null = null
let host: McpHostOptions | null = null
let images: McpImageStore | null = null
/** in-process servers (knowledge base, …) served over loopback; see mcp-host.ts */
let mcpHost: McpHost | null = null
let kb: KnowledgeBase | null = null
let digest: Digest | null = null

const DIGEST_SYSTEM =
  'You summarise documents for a two-person consultancy in regenerative agriculture. Answer in the language of the document.'

/**
 * One-shot summary through the provider chosen in Settings; providers that
 * only run inside their own CLI (claude-code) or need the Genspark session
 * fall back to Gemini with a key from mcp.json (digest, nano-banana,
 * transcribe or veo entries).
 */
async function summarizeForDigest(title: string, text: string): Promise<string> {
  let settings: Partial<AiSettings> = {}
  try {
    settings = JSON.parse(
      readFileSync(join(app.getPath('userData'), 'ai-settings.json'), 'utf8'),
    ) as Partial<AiSettings>
  } catch {
    /* no settings yet */
  }
  const user = `Summarise the document "${title}" in 5–8 bullet points with the key figures, decisions and dates, then one line starting with "Why it matters:".\n\n${text}`
  let provider: AiProviderId | null = null
  let config = { apiKey: '', model: '' }
  if (settings.provider && settings.providers) {
    const active = activeProvider(settings as AiSettings)
    const meta = AI_PROVIDERS.find((m) => m.id === active)
    if (meta && !meta.keyless && active !== 'genspark' && settings.providers[active]?.apiKey) {
      provider = active
      config = settings.providers[active]
    }
  }
  if (!provider) {
    const key = ['digest', 'nano-banana', 'transcribe', 'veo']
      .map((name) => mcpHost?.envFor(name).GEMINI_API_KEY)
      .find(Boolean)
    if (!key) {
      throw new Error(
        'No AI provider configured for the digest: add GEMINI_API_KEY to the "digest" entry in mcp.json, or choose an API-key provider in Settings',
      )
    }
    provider = 'gemini'
    config = { apiKey: key, model: mcpHost?.envFor('digest').DIGEST_MODEL || 'gemini-2.5-flash' }
  }
  const r = await chatForProvider(provider, config, DIGEST_SYSTEM, user)
  if (!r.ok || !r.content) throw new Error(r.error || 'empty summary')
  return r.content
}

function allowedServers(): string[] {
  const raw = readAppSettings(host!.settingsPath())[ALLOWED_KEY]
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : []
}

function setAllowed(server: string, allowed: boolean): void {
  const next = new Set(allowedServers())
  if (allowed) next.add(server)
  else next.delete(server)
  writeAppSettings(host!.settingsPath(), { [ALLOWED_KEY]: [...next].sort() })
}

async function askPermission(server: string, tool: string): Promise<McpPermissionDecision> {
  const text = host!.dialogText()
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts = {
    type: 'question' as const,
    message: text.title,
    detail: text.body(server, tool),
    buttons: [text.always, text.once, text.deny],
    defaultId: 1,
    cancelId: 2,
    noLink: true,
  }
  const { response } = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts)
  return response === 0 ? 'always' : response === 1 ? 'once' : 'deny'
}

function broadcastChanged(): void {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send(MCP_CHANNELS.changed)
  }
}

/** Folder of the servers the app ships (apps/shell/mcp-servers in a checkout, resources/mcp-servers packaged). */
export function builtinServersDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'mcp-servers')
    : join(app.getAppPath(), 'mcp-servers')
}

/** Environment every spawned server gets: where generated images go and the URL they are served from. */
function serverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(images
      ? { DUNEOFFICE_IMAGE_DIR: images.dir, DUNEOFFICE_IMAGE_URL_BASE: images.urlBase }
      : {}),
  }
}

/**
 * A built-in server is either served in-process by the host (a URL) or runs
 * as a script on the app's own Electron binary in node mode, so users need no
 * Node install.
 */
export function resolveBuiltinServer(spec: McpBuiltinSpec): McpStdioSpec | McpRemoteSpec | null {
  const hosted = mcpHost?.specFor(spec)
  if (hosted) return hosted
  const script = join(builtinServersDir(), `${spec.builtin.replace(/[^a-z0-9-]/gi, '')}.mjs`)
  if (!existsSync(script)) return null
  return {
    name: spec.name,
    type: 'stdio',
    command: process.execPath,
    args: [script],
    env: { ELECTRON_RUN_AS_NODE: '1', ...spec.env },
    disabled: spec.disabled,
  }
}

export function getMcpManager(): McpManager {
  if (!host) throw new Error('installMcp() must run before getMcpManager()')
  manager ??= new McpManager({
    configPath: defaultMcpConfigPath(),
    appName: 'DuneOffice',
    appVersion: app.getVersion(),
    permissions: {
      isAllowed: (server) => allowedServers().includes(server),
      ask: askPermission,
      remember: (server) => setAllowed(server, true),
    },
    env: serverEnv(),
    resolveBuiltin: resolveBuiltinServer,
    imageSink: (data, mimeType) => images?.save(data, mimeType) ?? null,
    log: host.log,
    onChange: broadcastChanged,
  })
  return manager
}

/** Everything the Settings pane shows. */
export function mcpStatus(): McpStatusInfo {
  const m = getMcpManager()
  return { configPath: m.configPath, errors: [...m.errors], servers: m.status() }
}

/**
 * Enabled entries for the Claude Code path, builtins resolved and the image
 * store's environment applied, because the CLI spawns its own copies.
 */
export function mcpExternalSpecs(): McpServerSpec[] {
  if (!manager) return []
  const extra: Record<string, string> = images
    ? { DUNEOFFICE_IMAGE_DIR: images.dir, DUNEOFFICE_IMAGE_URL_BASE: images.urlBase }
    : {}
  return manager.specs
    .filter((s) => !s.disabled)
    .map((s): McpServerSpec => (s.type === 'stdio' ? { ...s, env: { ...extra, ...s.env } } : s))
}

/** Permission for a tool the Claude Code CLI wants to run on an external server. */
export async function mcpPermit(server: string, tool: string): Promise<boolean> {
  if (allowedServers().includes(server)) return true
  const decision = await askPermission(server, tool)
  if (decision === 'always') setAllowed(server, true)
  return decision !== 'deny'
}

/** Registers the IPC surface, starts the image store, then the configured servers in the background. */
export async function installMcp(options: McpHostOptions): Promise<void> {
  host = options
  try {
    images = await startMcpImageStore(join(app.getPath('userData'), 'mcp-images'))
    // the editors download inserted images through the SSRF guard, which
    // blocks loopback; this one origin, behind a random token, is ours
    registerTrustedLocalOrigin(new URL(images.urlBase).origin)
  } catch (err) {
    options.log?.(`mcp: image store unavailable: ${String(err)}`)
  }
  try {
    mcpHost = new McpHost(options.log)
    kb = new KnowledgeBase({
      dbPath: join(app.getPath('userData'), 'kb', 'index.sqlite'),
      roots: [join(app.getPath('documents'), 'DuneOffice')],
      notesDir: join(homedir(), '.genoffice', 'kb'),
      fetchPdf: async (url) => {
        const res = await fetchWithSsrfGuard(url)
        return res?.ok ? Buffer.from(await res.arrayBuffer()) : null
      },
      log: options.log,
    })
    mcpHost.register(createKbServer(kb))
    const fetchText = async (url: string): Promise<string | null> => {
      const res = await fetchWithSsrfGuard(url)
      return res?.ok ? res.text() : null
    }
    mcpHost.register(createCiteServer(new Citer({ fetchText })))
    mcpHost.register(createDataServer(new DataConnectors({ fetchText })))
    mcpHost.register(createSandboxServer(new Sandbox()))
    mcpHost.register(createTranscribeServer(new Transcriber()))
    mcpHost.register(
      createDiagramServer({
        render: renderMermaid,
        saveImage: (data, mimeType) => images?.save(data, mimeType) ?? null,
      }),
    )
    mcpHost.register(
      createBrandServer(
        new Brand({
          path: join(homedir(), '.genoffice', 'brand.json'),
          imageUrlFor: (data, mimeType) => images?.save(data, mimeType) ?? null,
        }),
      ),
    )
    digest = new Digest({
      kb,
      notesDir: join(homedir(), '.genoffice', 'kb'),
      statePath: join(app.getPath('userData'), 'kb', 'digest.json'),
      summarize: summarizeForDigest,
      log: options.log,
    })
    mcpHost.register(createDigestServer(digest))
    // daily, only once a "digest" entry exists in mcp.json (so summaries are asked for)
    digest.schedule(24 * 60 * 60_000, 5 * 60_000, () =>
      (manager?.status() ?? []).some((s) => s.name === 'digest' && s.state === 'ready'),
    )
    if (options.google) {
      mcpHost.register(
        createGoogleServer(
          new GoogleTools({ token: options.google.token, scopes: options.google.scopes }),
        ),
      )
    }
    await mcpHost.start()
    void kb.start().catch((err: unknown) => options.log?.(`kb: first scan failed: ${String(err)}`))
  } catch (err) {
    options.log?.(`mcp: host unavailable: ${String(err)}`)
  }
  const m = getMcpManager()

  // editors' preload bridge
  ipcMain.handle(MCP_CHANNELS.listTools, () => m.listTools())
  ipcMain.handle(MCP_CHANNELS.callTool, async (_event, name: unknown, input: unknown) => {
    if (typeof name !== 'string') return { output: 'Invalid tool name.', isError: true }
    const args =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {}
    return m.callTool(name, args)
  })

  // Settings pane
  ipcMain.handle(HOME_CHANNELS.mcpStatus, () => mcpStatus())
  ipcMain.handle(HOME_CHANNELS.mcpReload, async () => {
    await m.reload()
    return mcpStatus()
  })
  ipcMain.handle(HOME_CHANNELS.mcpOpenConfig, async () => {
    const path = ensureMcpConfigFile(m.configPath)
    const error = await shell.openPath(path)
    if (error) shell.showItemInFolder(path)
    return path
  })
  ipcMain.handle(HOME_CHANNELS.mcpSetAllowed, (_event, server: unknown, allowed: unknown) => {
    if (typeof server === 'string' && server) setAllowed(server, allowed === true)
    broadcastChanged()
    return mcpStatus()
  })

  void m.start().catch((err: unknown) => options.log?.(`mcp: start failed: ${String(err)}`))
}

export async function shutdownMcp(): Promise<void> {
  images?.close()
  await manager?.stop()
  digest?.stop()
  kb?.close()
  closeDiagramWindow()
  await mcpHost?.stop()
}

/** The in-process host (for the digest job and tests); null before installMcp. */
export function getMcpHost(): McpHost | null {
  return mcpHost
}

export type { McpServerStatus }
