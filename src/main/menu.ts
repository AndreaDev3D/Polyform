// Native application menu, built from the shared definition.
//
// The window draws its own title bar and the menu BAR is hidden (see
// index.ts), but this Menu stays installed: it is what registers the
// accelerators and what implements the OS roles. The renderer's custom menu
// clicks these very items by id — see `clickMenuItem`.

import { BrowserWindow, Menu, shell } from 'electron'
import { MENU } from '../shared/menu-def'
import type { MenuActionId } from '../shared/types'

export function buildMenu(send: (id: MenuActionId) => void): Menu {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    ...MENU.map((menu) => ({
      // The & marks the Alt-key mnemonic on Windows/Linux.
      label: `&${menu.label}`,
      submenu: menu.items.map((item): Electron.MenuItemConstructorOptions => {
        if (item.separator) return { type: 'separator' }
        // On macOS, Exit belongs to the app menu; a File-menu quit reads wrong.
        const role = item.role === 'quit' && isMac ? ('close' as const) : item.role
        const base = {
          id: item.id,
          label: item.label,
          ...(item.accelerator ? { accelerator: item.accelerator } : {}),
          ...(item.displayOnlyAccelerator ? { registerAccelerator: false } : {}),
        }
        if (role) return { ...base, role }
        if (item.url) return { ...base, click: () => void shell.openExternal(item.url!) }
        return { ...base, click: () => item.action && send(item.action) }
      }),
    })),
  ]

  return Menu.buildFromTemplate(template)
}

/**
 * Invoke a menu item by id — the custom title bar's menu routes here, so a
 * command has exactly one implementation whichever way it was chosen.
 * Returns false when the id is unknown, so a stale UI cannot fail silently.
 */
export function clickMenuItem(id: string): boolean {
  const item = Menu.getApplicationMenu()?.getMenuItemById(id)
  if (!item) return false
  item.click()
  return true
}

export function installMenu(win: BrowserWindow): void {
  const menu = buildMenu((id) => {
    win.webContents.send('menu:action', id)
  })
  Menu.setApplicationMenu(menu)
  // Hide the bar, keep the menu: accelerators and roles stay live, and the
  // app draws its own menu in the custom title bar. macOS has no in-window
  // menu bar at all — its menu lives in the system bar and must stay visible.
  if (process.platform !== 'darwin') {
    win.setMenuBarVisibility(false)
    win.autoHideMenuBar = true
  }
}
