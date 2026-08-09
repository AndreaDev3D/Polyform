// The menu, defined once.
//
// The app draws its own title bar, so the native menu BAR is hidden — but the
// native Menu itself stays installed, because that is what registers every
// accelerator (Ctrl+S, Ctrl+Z, Ctrl+E…) and what implements the OS roles
// (devtools, fullscreen, quit). Removing it to draw our own would silently
// take every keyboard shortcut with it.
//
// So this file is the single source: main/menu.ts builds the native Menu from
// it (giving each item a stable id), and the renderer's MenuBar renders the
// same tree. Clicking a custom item asks main to click the real menu item by
// id, so there is exactly one implementation of every command and the two can
// never drift.

import type { MenuActionId } from './types'

export type MenuRole = 'quit' | 'close' | 'toggleDevTools' | 'togglefullscreen'

export interface MenuItemDef {
  /** Stable id, shared by the native item and the custom UI. */
  id?: string
  label?: string
  /** Electron accelerator string; also what the custom UI displays. */
  accelerator?: string
  /** Sent to the renderer's action layer when chosen. */
  action?: MenuActionId
  /** An OS-implemented item instead of an action. */
  role?: MenuRole
  /** Opens in the user's browser. */
  url?: string
  separator?: true
  /**
   * Display the accelerator without registering it. A bare printable key would
   * steal that character from every text field; the renderer handles these
   * with a focus guard instead.
   */
  displayOnlyAccelerator?: true
}

export interface MenuDef {
  label: string
  items: MenuItemDef[]
}

const sep: MenuItemDef = { separator: true }

export const MENU: MenuDef[] = [
  {
    label: 'File',
    items: [
      { id: 'file.new', label: 'New Project…', accelerator: 'CmdOrCtrl+N', action: 'file.new' },
      { id: 'file.open', label: 'Open Project…', accelerator: 'CmdOrCtrl+O', action: 'file.open' },
      sep,
      { id: 'file.save', label: 'Save', accelerator: 'CmdOrCtrl+S', action: 'file.save' },
      { id: 'file.saveAs', label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', action: 'file.saveAs' },
      sep,
      // "Import" for all three, because they are the same errand from the
      // user's side: bring a file on disk into the document. The old "Place"
      // wording split one group of menu items into two vocabularies.
      { id: 'file.importImage', label: 'Import Image…', accelerator: 'CmdOrCtrl+Shift+K', action: 'file.importImage' },
      { id: 'file.importModel', label: 'Import 3D Model…', action: 'file.importModel' },
      { id: 'file.importSvg', label: 'Import SVG…', action: 'file.importSvg' },
      // Named for the FILE, like every other import here — and accurate: it reads
      // a .fig you exported, and makes no claim to be anyone's importer.
      { id: 'file.importFig', label: 'Import .fig…', action: 'file.importFig' },
      sep,
      { id: 'file.exportPng', label: 'Export PNG…', accelerator: 'CmdOrCtrl+Shift+E', action: 'file.exportPng' },
      { id: 'file.exportSvg', label: 'Export SVG…', action: 'file.exportSvg' },
      sep,
      { id: 'app.quit', label: 'Exit', role: 'quit' },
    ],
  },
  {
    label: 'Edit',
    items: [
      { id: 'edit.undo', label: 'Undo', accelerator: 'CmdOrCtrl+Z', action: 'edit.undo' },
      { id: 'edit.redo', label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', action: 'edit.redo' },
      sep,
      { id: 'edit.copy', label: 'Copy', accelerator: 'CmdOrCtrl+C', action: 'edit.copy' },
      { id: 'edit.paste', label: 'Paste', accelerator: 'CmdOrCtrl+V', action: 'edit.paste' },
      { id: 'edit.duplicate', label: 'Duplicate', accelerator: 'CmdOrCtrl+D', action: 'edit.duplicate' },
      { id: 'edit.delete', label: 'Delete', action: 'edit.delete' },
      sep,
      { id: 'edit.selectAll', label: 'Select All', accelerator: 'CmdOrCtrl+A', action: 'edit.selectAll' },
    ],
  },
  {
    label: 'View',
    items: [
      { id: 'view.zoomIn', label: 'Zoom In', accelerator: 'CmdOrCtrl+=', action: 'view.zoomIn' },
      { id: 'view.zoomOut', label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', action: 'view.zoomOut' },
      { id: 'view.zoomFit', label: 'Zoom to Fit', accelerator: 'Shift+1', displayOnlyAccelerator: true, action: 'view.zoomFit' },
      { id: 'view.zoomSelection', label: 'Focus on Selection', accelerator: 'Shift+2', displayOnlyAccelerator: true, action: 'view.zoomSelection' },
      { id: 'view.zoomActual', label: 'Zoom to 100%', accelerator: 'CmdOrCtrl+0', action: 'view.zoomActual' },
      sep,
      { id: 'view.toggleGrid', label: 'Toggle Grid', accelerator: "CmdOrCtrl+'", action: 'view.toggleGrid' },
      { id: 'view.toggleRulers', label: 'Toggle Rulers', accelerator: 'Shift+R', displayOnlyAccelerator: true, action: 'view.toggleRulers' },
      { id: 'view.toggleGpu', label: 'GPU Rendering', action: 'view.toggleGpu' },
      { id: 'view.history', label: 'Version History', accelerator: 'CmdOrCtrl+Alt+H', action: 'view.history' },
      sep,
      { id: 'view.devTools', label: 'Developer Tools', role: 'toggleDevTools' },
      { id: 'view.fullscreen', label: 'Full Screen', role: 'togglefullscreen' },
    ],
  },
  {
    label: 'Object',
    items: [
      { id: 'object.group', label: 'Group Selection', accelerator: 'CmdOrCtrl+G', action: 'object.group' },
      { id: 'object.ungroup', label: 'Ungroup', accelerator: 'CmdOrCtrl+Shift+G', action: 'object.ungroup' },
      { id: 'object.frameSelection', label: 'Frame Selection', accelerator: 'CmdOrCtrl+Alt+G', action: 'object.frameSelection' },
      sep,
      { id: 'object.rotate90', label: 'Rotate 90° Right', action: 'object.rotate90' },
      { id: 'object.flipH', label: 'Flip Horizontal', accelerator: 'Shift+H', displayOnlyAccelerator: true, action: 'object.flipH' },
      { id: 'object.flipV', label: 'Flip Vertical', accelerator: 'Shift+V', displayOnlyAccelerator: true, action: 'object.flipV' },
      sep,
      { id: 'object.bringForward', label: 'Bring Forward', accelerator: 'CmdOrCtrl+]', action: 'object.bringForward' },
      { id: 'object.sendBackward', label: 'Send Backward', accelerator: 'CmdOrCtrl+[', action: 'object.sendBackward' },
      { id: 'object.bringToFront', label: 'Bring to Front', accelerator: 'CmdOrCtrl+Shift+]', action: 'object.bringToFront' },
      { id: 'object.sendToBack', label: 'Send to Back', accelerator: 'CmdOrCtrl+Shift+[', action: 'object.sendToBack' },
      sep,
      { id: 'object.toggleMask', label: 'Use as Mask', accelerator: 'CmdOrCtrl+Alt+M', action: 'object.toggleMask' },
      sep,
      { id: 'object.createComponent', label: 'Create Component', accelerator: 'CmdOrCtrl+Alt+K', action: 'object.createComponent' },
      { id: 'object.createInstance', label: 'Create Instance', action: 'object.createInstance' },
      { id: 'object.detachInstance', label: 'Detach Instance', accelerator: 'CmdOrCtrl+Alt+B', action: 'object.detachInstance' },
      sep,
      { id: 'object.flatten', label: 'Flatten', accelerator: 'CmdOrCtrl+E', action: 'object.flatten' },
      { id: 'object.carve', label: 'Carve Holes', accelerator: 'CmdOrCtrl+Shift+H', action: 'object.carve' },
      sep,
      { id: 'object.union', label: 'Boolean Union', action: 'object.union' },
      { id: 'object.subtract', label: 'Boolean Subtract', action: 'object.subtract' },
      { id: 'object.intersect', label: 'Boolean Intersect', action: 'object.intersect' },
      { id: 'object.exclude', label: 'Boolean Exclude', action: 'object.exclude' },
    ],
  },
  {
    label: 'Plugins',
    items: [{ id: 'plugins.run', label: 'Run Plugin Script…', action: 'plugins.run' }],
  },
  {
    label: 'Agent',
    items: [{ id: 'agent.connection', label: 'Agent Connection…', action: 'agent.connection' }],
  },
  {
    label: 'Help',
    items: [
      { id: 'help.checkUpdates', label: 'Check for Updates…', action: 'help.checkUpdates' },
      sep,
      { id: 'help.about', label: 'About Polyform', action: 'help.about' },
      { id: 'help.licenses', label: 'Third-Party Licences', action: 'help.licenses' },
      { id: 'help.github', label: 'GitHub Repository', url: 'https://github.com/AndreaDev3D/Polyform' },
    ],
  },
]

/** Electron accelerator string -> what a person reads on this platform. */
export function formatAccelerator(accel: string, platform: string): string {
  const mac = platform === 'darwin'
  return accel
    .split('+')
    .map((part) => {
      switch (part) {
        case 'CmdOrCtrl':
        case 'CommandOrControl':
          return mac ? '⌘' : 'Ctrl'
        case 'Cmd':
        case 'Command':
          return '⌘'
        case 'Ctrl':
        case 'Control':
          return mac ? '⌃' : 'Ctrl'
        case 'Alt':
          return mac ? '⌥' : 'Alt'
        case 'Shift':
          return mac ? '⇧' : 'Shift'
        case '=':
          return '+'
        default:
          return part
      }
    })
    .join(mac ? '' : '+')
}
