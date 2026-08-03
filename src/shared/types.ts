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

/**
 * What an agent may do. Each is granted separately and revocable live.
 * Read capabilities default on when the user starts the endpoint; `edit`
 * — the one that CHANGES the document — defaults off (ADR-022).
 */
export type McpCapability = 'document' | 'selection' | 'changes' | 'render' | 'edit'

export type McpGrants = Record<McpCapability, boolean>

export interface McpStatus {
  running: boolean
  port: number | null
  token: string | null
  /** Connected agent sessions — drives the "agent connected" indicator. */
  clients: number
  grants: McpGrants
  /** Tool calls served since start; the indicator's "being read" signal. */
  calls: number
  /** Capability behind the most recent call, for the activity line. */
  lastCall: McpCapability | null
  /** Epoch ms of the most recent call. */
  lastCallAt: number | null
}

/**
 * Control of the agent endpoint (v0.6, ADR-021).
 *
 * Deliberately NOT part of `PolyformApi`: plugins execute in the renderer's
 * own realm (`new Function`, roadmap 3.4 / F-15), so anything hanging off
 * `window.polyform` is reachable by a plugin script — and a plugin that
 * could call `mcpStart()` would make the consent panel a decoration. This
 * surface is handed out once, to the first claimer, which is Polyform's own
 * startup code; see `PolyformAgentGate`.
 */
export interface PolyformAgentApi {
  mcpStatus: () => Promise<McpStatus>
  mcpStart: (grants?: Partial<McpGrants>) => Promise<McpStatus>
  mcpStop: () => Promise<McpStatus>
  /** Grant or revoke a capability; takes effect on connected sessions. */
  mcpSetGrants: (grants: Partial<McpGrants>) => Promise<McpStatus>
  /** Pushed whenever the endpoint, its grants, or its activity change. */
  onMcpStatus: (cb: (status: McpStatus) => void) => () => void
  mcpSceneReply: (id: number, ok: boolean, payload: unknown) => void
  onMcpSceneRequest: (cb: (id: number, method: string, params: unknown) => void) => () => void
}

/** One-shot handout of {@link PolyformAgentApi}; later callers get null. */
export interface PolyformAgentGate {
  claim: () => PolyformAgentApi | null
}

export type MenuActionId =
  | 'file.new'
  | 'file.open'
  | 'file.save'
  | 'file.saveAs'
  | 'file.placeImage'
  | 'file.placeModel'
  | 'file.importSvg'
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
  | 'view.toggleRulers'
  | 'view.toggleGpu'
  | 'object.group'
  | 'object.ungroup'
  | 'object.frameSelection'
  | 'object.bringForward'
  | 'object.sendBackward'
  | 'object.bringToFront'
  | 'object.sendToBack'
  | 'object.flatten'
  | 'object.union'
  | 'object.subtract'
  | 'object.intersect'
  | 'object.exclude'
  | 'object.toggleMask'
  | 'object.createComponent'
  | 'object.createInstance'
  | 'object.detachInstance'
  | 'view.history'
  | 'plugins.run'
  | 'agent.connection'
  | 'help.about'

export interface PolyformApi {
  platform: string
  projectNew: () => Promise<OpenProjectResult | null>
  projectOpen: (path?: string) => Promise<OpenProjectResult | null>
  projectSave: (payload: SaveProjectPayload) => Promise<boolean>
  projectSaveAs: (payload: SaveProjectPayload) => Promise<ProjectInfo | null>
  /** Click a native menu item by id (the custom title bar's menu). */
  menuInvoke: (id: string) => Promise<boolean>
  recentsList: () => Promise<RecentEntry[]>
  /** A recent bundle's saved preview PNG; null when it has none. */
  recentsThumbnail: (path: string) => Promise<Uint8Array | null>
  appVersion: () => Promise<string>
  historyAppend: (label: string, opsJson: string) => Promise<number>
  historySetCursor: (cursor: number) => Promise<void>
  assetsImportDialog: (kind?: 'image' | 'model') => Promise<ImportedAsset[] | null>
  assetsRead: (hash: string) => Promise<AssetData | null>
  svgImportDialog: () => Promise<{ fileName: string; text: string }[] | null>
  /** Pick a .poly bundle to attach as a library. */
  libraryPick: () => Promise<{ path: string; title: string } | null>
  /** Read a library bundle's manifest + scene bytes. */
  libraryRead: (path: string) => Promise<{ title: string; sceneBytes: Uint8Array; updatedAt: string } | null>
  /** Pick and read a plugin script (.js). */
  pluginOpenDialog: () => Promise<{ fileName: string; text: string } | null>
  exportSave: (defaultName: string, kind: 'png' | 'svg', data: Uint8Array) => Promise<string | null>
  /** Write renderer-produced bytes as a content-addressed project asset. */
  assetsWrite: (bytes: Uint8Array, ext: string) => Promise<{ hash: string; mime: string } | null>
  /** Background-removal model (v0.4.1): consent-gated one-time download. */
  /** Agent connectivity (v0.6 spike, ADR-021): the loopback MCP endpoint. */
  bgModelStatus: () => Promise<{ ready: boolean; sizeMB: number; inputSize: number }>
  bgModelEnsure: () => Promise<{ ok: boolean; error?: string }>
  bgModelRead: () => Promise<Uint8Array | null>
  bgOrtRuntime: () => Promise<{ mjs: Uint8Array; wasm: Uint8Array } | null>
  onBgModelProgress: (cb: (received: number, total: number) => void) => () => void
  /** CLI mode only (7.4): signal the bundle is loaded and the bridge is live. */
  cliReady: () => void
  setDirty: (dirty: boolean) => void
  setTitle: (title: string) => void
  onMenuAction: (cb: (id: MenuActionId) => void) => () => void
  onRequestClose: (cb: () => void) => () => void
  confirmClose: () => void
}
