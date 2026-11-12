/// Native right-click menu for surfaces without a self-drawn one (AI panel,
/// inputs, chrome). Renderer-drawn menus call preventDefault() on the DOM
/// contextmenu event, which suppresses this webContents event entirely
/// (verified on Electron 41), so the two never stack.
import type { App, ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron'

export interface ContextMenuLabels {
  cut: string
  copy: string
  paste: string
  selectAll: string
}

const EN: ContextMenuLabels = { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All' }

// One shared table instead of these 4 keys duplicated into every app's
// main-process dictionary; strings match the docs Edit menu.
const LABELS: Record<string, ContextMenuLabels> = {
  en: EN,
  sv: { cut: 'Klipp ut', copy: 'Kopiera', paste: 'Klistra in', selectAll: 'Markera allt' },
  es: { cut: 'Cortar', copy: 'Copiar', paste: 'Pegar', selectAll: 'Seleccionar todo' },
}

export function contextMenuLabels(lang: string): ContextMenuLabels {
  return LABELS[lang] ?? EN
}

export type ContextMenuItem =
  | { type: 'separator' }
  | { action: 'replaceMisspelling'; label: string }
  | { action: 'cut' | 'copy' | 'paste' | 'selectAll'; label: string; enabled: boolean }

type BuildParams = Pick<
  ContextMenuParams,
  'isEditable' | 'selectionText' | 'misspelledWord' | 'dictionarySuggestions' | 'editFlags'
>

/** Empty result means: don't show a menu. */
export function buildContextMenuItems(
  params: BuildParams,
  labels: ContextMenuLabels,
): ContextMenuItem[] {
  const flags = params.editFlags
  if (params.isEditable) {
    const items: ContextMenuItem[] = []
    if (params.misspelledWord && params.dictionarySuggestions.length) {
      for (const word of params.dictionarySuggestions)
        items.push({ action: 'replaceMisspelling', label: word })
      items.push({ type: 'separator' })
    }
    items.push(
      { action: 'cut', label: labels.cut, enabled: flags.canCut },
      { action: 'copy', label: labels.copy, enabled: flags.canCopy },
      { action: 'paste', label: labels.paste, enabled: flags.canPaste },
      { type: 'separator' },
      { action: 'selectAll', label: labels.selectAll, enabled: flags.canSelectAll },
    )
    return items
  }
  if (params.selectionText.trim()) {
    return [
      { action: 'copy', label: labels.copy, enabled: flags.canCopy },
      { action: 'selectAll', label: labels.selectAll, enabled: flags.canSelectAll },
    ]
  }
  return []
}

// Symbol.for: survives multiple bundled copies (see navigation-guard.ts).
const INSTALLED = Symbol.for('genoffice.context-menu-installed')

export function installContextMenu(app: App, getLabels: () => ContextMenuLabels): void {
  const holder = app as unknown as Record<symbol, boolean | undefined>
  if (holder[INSTALLED]) return
  holder[INSTALLED] = true
  app.on('web-contents-created', (_event, contents) => {
    contents.on('context-menu', (_e, params) => {
      void popupMenu(contents, params, getLabels())
    })
  })
}

async function popupMenu(
  contents: WebContents,
  params: ContextMenuParams,
  labels: ContextMenuLabels,
): Promise<void> {
  const items = buildContextMenuItems(params, labels)
  if (!items.length) return
  // Dynamic import keeps this module loadable outside Electron (unit tests).
  const { Menu } = await import('electron')
  const template = items.map((item): MenuItemConstructorOptions => {
    if ('type' in item) return { type: 'separator' }
    if (item.action === 'replaceMisspelling')
      return { label: item.label, click: () => contents.replaceMisspelling(item.label) }
    const action = item.action
    return { label: item.label, enabled: item.enabled, click: () => contents[action]() }
  })
  Menu.buildFromTemplate(template).popup()
}
