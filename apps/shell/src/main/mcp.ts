/**
 * Electron side of the MCP integration: one McpManager for the app, the
 * permission dialog, the persisted "always allow" list, and the IPC that
 * every editor's preload bridge (window.mcpBridge) and the Settings pane use.
 * The protocol client itself lives in @genoffice/mcp-client and knows
 * nothing about Electron.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, webContents } from 'electron'
import { MCP_CHANNELS } from '@genoffice/agent-core'
import {
  McpManager,
  defaultMcpConfigPath,
  ensureMcpConfigFile,
  type McpPermissionDecision,
  type McpServerSpec,
  type McpServerStatus,
} from '@genoffice/mcp-client'
import { readAppSettings, writeAppSettings } from './app-settings'
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
  log?: (message: string) => void
}

let manager: McpManager | null = null
let host: McpHostOptions | null = null

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

/** Enabled entries as configured, for the Claude Code path (the CLI spawns its own copies). */
export function mcpExternalSpecs(): McpServerSpec[] {
  return manager ? manager.specs.filter((s) => !s.disabled) : []
}

/** Permission for a tool the Claude Code CLI wants to run on an external server. */
export async function mcpPermit(server: string, tool: string): Promise<boolean> {
  if (allowedServers().includes(server)) return true
  const decision = await askPermission(server, tool)
  if (decision === 'always') setAllowed(server, true)
  return decision !== 'deny'
}

/** Registers the IPC surface and starts the configured servers in the background. */
export function installMcp(options: McpHostOptions): void {
  host = options
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
  await manager?.stop()
}

export type { McpServerStatus }
