// Context-isolated bridge exposing the typed Polyform IPC API to the renderer.

import { contextBridge, ipcRenderer } from 'electron'
import type {
  McpStatus,
  MenuActionId,
  PolyformAgentApi,
  PolyformAgentGate,
  PolyformApi,
  SaveProjectPayload,
} from '../shared/types'

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

// Harness-only hook (see main): absent unless the probe env flag is set.
if (process.env['POLYFORM_AGENT_TEST'] === '1') {
  contextBridge.exposeInMainWorld('__polyformTest', {
    projectCreate: (dir: string) => ipcRenderer.invoke('test:projectCreate', dir),
  })
}

// Agent endpoint control (v0.6, ADR-021 / F-20) is deliberately NOT on
// `window.polyform`. Plugin scripts run in the renderer's own realm, so they
// can read anything exposed there — and a plugin able to call `mcpStart()`
// would reduce the consent panel to decoration. Instead the surface is
// handed out exactly once: Polyform's own startup code claims it before any
// plugin can be loaded (loading one needs a file dialog and a confirmation),
// and every later caller gets null.
const agentApi: PolyformAgentApi = {
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpStart: (grants) => ipcRenderer.invoke('mcp:start', grants),
  mcpStop: () => ipcRenderer.invoke('mcp:stop'),
  mcpSetGrants: (grants) => ipcRenderer.invoke('mcp:setGrants', grants),
  onMcpStatus: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, status: McpStatus) => cb(status)
    ipcRenderer.on('mcp:status', listener)
    return () => ipcRenderer.removeListener('mcp:status', listener)
  },
  mcpSceneReply: (id, ok, payload) => ipcRenderer.send('mcp:sceneReply', id, ok, payload),
  onMcpSceneRequest: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, id: number, method: string, params: unknown) =>
      cb(id, method, params)
    ipcRenderer.on('mcp:sceneRequest', listener)
    return () => ipcRenderer.removeListener('mcp:sceneRequest', listener)
  },
}

let agentClaimed = false
const agentGate: PolyformAgentGate = {
  claim: () => {
    if (agentClaimed) return null
    agentClaimed = true
    return agentApi
  },
}

contextBridge.exposeInMainWorld('polyformAgent', agentGate)
