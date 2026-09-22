/**
 * Hidden window that renders Mermaid diagrams for the diagram MCP server
 * (hosted/diagram.ts). The page (renderer/diagram.html) bundles mermaid and
 * exposes window.renderDiagram; this module owns the window's lifecycle and
 * serialises calls so two renders never share the DOM.
 */
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { DiagramRenderer } from './hosted/diagram'

let win: BrowserWindow | null = null
let queue: Promise<unknown> = Promise.resolve()

async function ensureWindow(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 1000,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  win.on('closed', () => {
    win = null
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/diagram.html`)
  } else {
    await win.loadFile(join(__dirname, '../renderer/diagram.html'))
  }
  return win
}

export const renderMermaid: DiagramRenderer = (code, theme, scale) => {
  const run = async () => {
    const w = await ensureWindow()
    const r = (await w.webContents.executeJavaScript(
      `window.renderDiagram(${JSON.stringify(code)}, ${JSON.stringify(theme)}, ${Number(scale) || 2})`,
      true,
    )) as { png: string; svg: string; width: number; height: number }
    return { png: Buffer.from(r.png, 'base64'), svg: r.svg, width: r.width, height: r.height }
  }
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}

export function closeDiagramWindow(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}
