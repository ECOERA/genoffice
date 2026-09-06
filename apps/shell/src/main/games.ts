/**
 * Bundled HTML games hosted as shell tabs. A game is a self-contained static
 * folder (index.html plus assets) under apps/shell/games/<id> in a source
 * checkout and resources/games/<id> in a packaged build; the tab loads it
 * straight from disk in a sandboxed view with no preload and no Node access.
 */
import { WebContentsView, app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface GameSpec {
  /** folder name under the games root; also the tab's identity */
  id: string
  /** tab title */
  title: string
  entry: string
}

export const GAMES: readonly GameSpec[] = [
  { id: 'dune-adventure', title: 'Dune: Sands of Arrakis', entry: 'index.html' },
]

export function gameById(id: unknown): GameSpec | null {
  return GAMES.find((g) => g.id === id) ?? null
}

export function gamesRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, 'games') : join(app.getAppPath(), 'games')
}

export function gameEntryPath(game: GameSpec): string {
  return join(gamesRoot(), game.id, game.entry)
}

export function gameIsInstalled(game: GameSpec): boolean {
  return existsSync(gameEntryPath(game))
}

/**
 * Injected after load. Games ship without knowing about the shell, so two
 * things live here:
 * - F11 (and Ctrl+Cmd+F on macOS) toggles HTML fullscreen, which the tab
 *   manager already grows over the tab strip; Esc leaves it.
 * - A hidden WebContentsView still reports the page as visible, so a hidden
 *   game would keep rendering. `__duneofficeSetActive(false)` parks every
 *   requestAnimationFrame callback until the tab is shown again; games clamp
 *   the frame delta, so resuming continues from where the player left.
 */
const GAME_HELPER = `(() => {
  if (window.__duneofficeGameHelper) return
  window.__duneofficeGameHelper = true
  const realRaf = window.requestAnimationFrame.bind(window)
  let active = true
  let parked = []
  window.requestAnimationFrame = (cb) => {
    if (active) return realRaf(cb)
    parked.push(cb)
    return 0
  }
  window.__duneofficeSetActive = (on) => {
    active = Boolean(on)
    if (!active) return
    const resume = parked
    parked = []
    for (const cb of resume) realRaf(cb)
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.fullscreenElement) {
      // the game still sees Escape; only the fullscreen state changes
      void document.exitFullscreen()
      return
    }
    const toggle = e.key === 'F11' || (e.key.toLowerCase() === 'f' && e.metaKey && e.ctrlKey)
    if (!toggle) return
    e.preventDefault()
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => {})
  }, true)
})()`

export function createGameView(game: GameSpec): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // music starts from the title screen without a click
      autoplayPolicy: 'no-user-gesture-required',
      // a hidden tab should not burn CPU on its render loop
      backgroundThrottling: true,
    },
  })
  view.setBackgroundColor('#1a0a00')
  const wc = view.webContents
  // the game is the only page this view ever shows
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (event) => event.preventDefault())
  wc.on('did-finish-load', () => {
    void wc.executeJavaScript(GAME_HELPER).catch(() => {})
  })
  void wc.loadFile(gameEntryPath(game))
  return view
}

/** In front: sound on and frames running. Behind another tab: silent and frozen. */
export function setGameViewActive(view: WebContentsView, active: boolean): void {
  const wc = view.webContents
  if (wc.isDestroyed()) return
  wc.setAudioMuted(!active)
  void wc.executeJavaScript(`window.__duneofficeSetActive?.(${active})`).catch(() => {})
}
