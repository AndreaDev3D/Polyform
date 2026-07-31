// Types shared between the Electron main process and the renderer.

export interface ViewportState {
  zoom: number
  pan_x: number
  pan_y: number
}

export interface ProjectManifest {
  version: string
  app_build: string
  project_id: string
  title: string
  created_at: string
  updated_at: string
  viewport_state: ViewportState
}

export interface ProjectInfo {
  /** Absolute path of the .poly directory bundle. */
  path: string
  manifest: ProjectManifest
}

export interface JournalEntry {
  seq: number
  label: string
  /** JSON-encoded PatchOp[] */
  ops: string
  created_at: string
}

export interface JournalState {
  entries: JournalEntry[]
  /** Number of entries currently applied (undo cursor). 0..entries.length */
  cursor: number
}

export interface OpenProjectResult {
  info: ProjectInfo
  /** scene.bin bytes; null for a brand-new/empty project. */
  sceneBytes: Uint8Array | null
  journal: JournalState
}

export interface SaveProjectPayload {
  sceneBytes: Uint8Array
  viewport: ViewportState
  /** Optional PNG thumbnail bytes for the bundle. */
  thumbnailPng?: Uint8Array
}

export interface RecentEntry {
  path: string
  title: string
  openedAt: string
}

export interface ImportedAsset {
  hash: string
  ext: string
  mime: string
  fileName: string
  bytes: Uint8Array
}

export interface AssetData {
  bytes: Uint8Array
  mime: string
}

export type MenuActionId =
  | 'file.new'
  | 'file.open'
  | 'file.save'
  | 'file.saveAs'
  | 'file.placeImage'
  | 'file.exportPng'
  | 'file.exportSvg'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.copy'
  | 'edit.paste'
  | 'edit.duplicate'
  | 'edit.delete'
  | 'edit.selectAll'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.zoomFit'
  | 'view.zoomActual'
  | 'view.toggleGrid'
  | 'object.group'
  | 'object.ungroup'
  | 'object.frameSelection'
  | 'object.bringForward'
  | 'object.sendBackward'
  | 'object.bringToFront'
  | 'object.sendToBack'
  | 'object.union'
  | 'object.subtract'
  | 'object.intersect'
  | 'object.exclude'
  | 'help.about'

export interface PolyformApi {
  platform: string
  projectNew: () => Promise<OpenProjectResult | null>
  projectOpen: (path?: string) => Promise<OpenProjectResult | null>
  projectSave: (payload: SaveProjectPayload) => Promise<boolean>
  projectSaveAs: (payload: SaveProjectPayload) => Promise<ProjectInfo | null>
  recentsList: () => Promise<RecentEntry[]>
  historyAppend: (label: string, opsJson: string) => Promise<number>
  historySetCursor: (cursor: number) => Promise<void>
  assetsImportDialog: () => Promise<ImportedAsset[] | null>
  assetsRead: (hash: string) => Promise<AssetData | null>
  exportSave: (defaultName: string, kind: 'png' | 'svg', data: Uint8Array) => Promise<string | null>
  setDirty: (dirty: boolean) => void
  setTitle: (title: string) => void
  onMenuAction: (cb: (id: MenuActionId) => void) => () => void
  onRequestClose: (cb: () => void) => () => void
  confirmClose: () => void
}
