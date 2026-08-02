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
  assetsImportDialog: (kind?: 'image' | 'model') => ipcRenderer.invoke('assets:importDialog', kind),
  assetsRead: (hash) => ipcRenderer.invoke('assets:read', hash),
  svgImportDialog: () => ipcRenderer.invoke('import:svgDialog'),
  libraryPick: () => ipcRenderer.invoke('library:pick'),
  libraryRead: (path) => ipcRenderer.invoke('library:read', path),
  pluginOpenDialog: () => ipcRenderer.invoke('plugins:openDialog'),
  exportSave: (defaultName, kind, data) => ipcRenderer.invoke('export:save', defaultName, kind, data),
  assetsWrite: (bytes, ext) => ipcRenderer.invoke('assets:write', bytes, ext),
  bgModelStatus: () => ipcRenderer.invoke('bgmodel:status'),
  bgModelEnsure: () => ipcRenderer.invoke('bgmodel:ensure'),
  bgModelRead: () => ipcRenderer.invoke('bgmodel:read'),
  bgOrtRuntime: () => ipcRenderer.invoke('bgmodel:ort'),
  onBgModelProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, p: { received: number; total: number }) =>
      cb(p.received, p.total)
    ipcRenderer.on('bgmodel:progress', listener)
    return () => ipcRenderer.removeListener('bgmodel:progress', listener)
  },
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
