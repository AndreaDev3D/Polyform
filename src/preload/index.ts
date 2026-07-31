// Context-isolated bridge exposing the typed Polyform IPC API to the renderer.

import { contextBridge, ipcRenderer } from 'electron'
import type { MenuActionId, PolyformApi, SaveProjectPayload } from '../shared/types'

const api: PolyformApi = {
  platform: process.platform,
  projectNew: () => ipcRenderer.invoke('project:new'),
  projectOpen: (path?: string) => ipcRenderer.invoke('project:open', path),
  projectSave: (payload: SaveProjectPayload) => ipcRenderer.invoke('project:save', payload),
  projectSaveAs: (payload: SaveProjectPayload) => ipcRenderer.invoke('project:saveAs', payload),
  recentsList: () => ipcRenderer.invoke('recents:list'),
  historyAppend: (label, opsJson) => ipcRenderer.invoke('history:append', label, opsJson),
  historySetCursor: (cursor) => ipcRenderer.invoke('history:setCursor', cursor),
  assetsImportDialog: () => ipcRenderer.invoke('assets:importDialog'),
  assetsRead: (hash) => ipcRenderer.invoke('assets:read', hash),
  exportSave: (defaultName, kind, data) => ipcRenderer.invoke('export:save', defaultName, kind, data),
  setDirty: (dirty) => ipcRenderer.send('app:set-dirty', dirty),
  setTitle: () => ipcRenderer.send('app:set-title'),
  onMenuAction: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, id: MenuActionId) => cb(id)
    ipcRenderer.on('menu:action', listener)
    return () => ipcRenderer.removeListener('menu:action', listener)
  },
  onRequestClose: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('app:request-close', listener)
    return () => ipcRenderer.removeListener('app:request-close', listener)
  },
  confirmClose: () => ipcRenderer.send('app:confirm-close'),
}

contextBridge.exposeInMainWorld('polyform', api)
