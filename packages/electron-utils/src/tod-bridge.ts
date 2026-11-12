/// Tod's bridge between any renderer and the shell's main process.
///
/// Every app is its own renderer but they all share one main process, so the
/// break clock is global and the channels are too: a preload installs this and
/// gets `window.todBridge` without each app inventing its own IPC. Nothing
/// here is app-specific — the shell handles all three channels once
/// (apps/shell/src/main/index.ts).
import { contextBridge, ipcRenderer } from 'electron'

export const TOD_CHANNELS = {
  /** renderer → main: this window is focused and being worked in */
  ping: 'tod:ping',
  /** main → renderer: a break is due; payload is whole minutes worked */
  breakDue: 'tod:break-due',
  /** renderer → main: the user accepted — open Dune Adventure and reset the clock */
  playGame: 'tod:play-game',
} as const

export interface TodBridge {
  /** report that this window is active; the main process accumulates the time */
  ping(): void
  /** subscribe to break nudges; returns an unsubscribe */
  onBreakDue(handler: (minutes: number) => void): () => void
  /**
   * Take the break: the shell opens the game tab and restarts the clock.
   * There is deliberately no "declined" call — the snooze is applied when the
   * nudge is sent, so an ignored nudge and a declined one are the same to the
   * main process, and the renderer only has to drop its own state.
   */
  playGame(): void
}

/** how often a focused renderer reports in; must stay well under MAX_PING_GAP_MS */
export const TOD_PING_INTERVAL_MS = 30_000

export function installTodBridge(): void {
  const api: TodBridge = {
    ping: () => ipcRenderer.send(TOD_CHANNELS.ping),
    onBreakDue: (handler) => {
      const listener = (_event: unknown, minutes: unknown) => {
        if (typeof minutes === 'number' && Number.isFinite(minutes)) handler(minutes)
      }
      ipcRenderer.on(TOD_CHANNELS.breakDue, listener)
      return () => ipcRenderer.removeListener(TOD_CHANNELS.breakDue, listener)
    },
    playGame: () => ipcRenderer.send(TOD_CHANNELS.playGame),
  }
  contextBridge.exposeInMainWorld('todBridge', api)
}
