// Native application menu. Every item dispatches a MenuActionId to the
// renderer, which routes it through the same action layer as shortcuts.

import { BrowserWindow, Menu, shell } from 'electron'
import type { MenuActionId } from '../shared/types'

export function buildMenu(send: (id: MenuActionId) => void): Menu {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: '&File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+N', click: () => send('file.new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => send('file.open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('file.save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('file.saveAs') },
        { type: 'separator' },
        { label: 'Place Image…', accelerator: 'CmdOrCtrl+Shift+K', click: () => send('file.placeImage') },
        { label: 'Place 3D Model…', click: () => send('file.placeModel') },
        { label: 'Import SVG…', click: () => send('file.importSvg') },
        { type: 'separator' },
        { label: 'Export PNG…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('file.exportPng') },
        { label: 'Export SVG…', click: () => send('file.exportSvg') },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('edit.undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('edit.redo') },
        { type: 'separator' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => send('edit.copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => send('edit.paste') },
        { label: 'Duplicate', accelerator: 'CmdOrCtrl+D', click: () => send('edit.duplicate') },
        { label: 'Delete', click: () => send('edit.delete') },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => send('edit.selectAll') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('view.zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('view.zoomOut') },
        // registerAccelerator: false — a bare printable-key accelerator would
        // steal '!' from text fields; the renderer handles Shift+1 with a
        // proper focus guard and the menu still displays the hint.
        { label: 'Zoom to Fit', accelerator: 'Shift+1', registerAccelerator: false, click: () => send('view.zoomFit') },
        { label: 'Zoom to 100%', accelerator: 'CmdOrCtrl+0', click: () => send('view.zoomActual') },
        { type: 'separator' },
        { label: 'Toggle Grid', accelerator: "CmdOrCtrl+'", click: () => send('view.toggleGrid') },
        // registerAccelerator: false — bare Shift+R would steal 'R' from text
        // fields; the renderer handles it with a focus guard.
        { label: 'Toggle Rulers', accelerator: 'Shift+R', registerAccelerator: false, click: () => send('view.toggleRulers') },
        { label: 'GPU Rendering (Beta)', click: () => send('view.toggleGpu') },
        { label: 'Version History', accelerator: 'CmdOrCtrl+Alt+H', click: () => send('view.history') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Plugins',
      submenu: [{ label: 'Run Plugin Script…', click: () => send('plugins.run') }],
    },
    {
      label: '&Agent',
      submenu: [{ label: 'Agent Connection…', click: () => send('agent.connection') }],
    },
    {
      label: '&Object',
      submenu: [
        { label: 'Group Selection', accelerator: 'CmdOrCtrl+G', click: () => send('object.group') },
        { label: 'Ungroup', accelerator: 'CmdOrCtrl+Shift+G', click: () => send('object.ungroup') },
        { label: 'Frame Selection', accelerator: 'CmdOrCtrl+Alt+G', click: () => send('object.frameSelection') },
        { type: 'separator' },
        { label: 'Bring Forward', accelerator: 'CmdOrCtrl+]', click: () => send('object.bringForward') },
        { label: 'Send Backward', accelerator: 'CmdOrCtrl+[', click: () => send('object.sendBackward') },
        { label: 'Bring to Front', accelerator: 'CmdOrCtrl+Shift+]', click: () => send('object.bringToFront') },
        { label: 'Send to Back', accelerator: 'CmdOrCtrl+Shift+[', click: () => send('object.sendToBack') },
        { type: 'separator' },
        { label: 'Use as Mask', accelerator: 'CmdOrCtrl+Alt+M', click: () => send('object.toggleMask') },
        { type: 'separator' },
        { label: 'Create Component', accelerator: 'CmdOrCtrl+Alt+K', click: () => send('object.createComponent') },
        { label: 'Create Instance', click: () => send('object.createInstance') },
        { label: 'Detach Instance', accelerator: 'CmdOrCtrl+Alt+B', click: () => send('object.detachInstance') },
        { type: 'separator' },
        { label: 'Boolean Union', click: () => send('object.union') },
        { label: 'Boolean Subtract', click: () => send('object.subtract') },
        { label: 'Boolean Intersect', click: () => send('object.intersect') },
        { label: 'Boolean Exclude', click: () => send('object.exclude') },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'About Polyform', click: () => send('help.about') },
        {
          label: 'GitHub Repository',
          click: () => void shell.openExternal('https://github.com/polyform/polyform'),
        },
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}

export function installMenu(win: BrowserWindow): void {
  const menu = buildMenu((id) => {
    win.webContents.send('menu:action', id)
  })
  Menu.setApplicationMenu(menu)
}
