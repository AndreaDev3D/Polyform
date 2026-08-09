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
  /** Absolute path of the bundle DIRECTORY. */
  path: string
  manifest: ProjectManifest
  /**
   * Manifest file name inside the bundle: `<Name>.poly`, or `manifest.json` for
   * a bundle written before v0.7. Saves go back to the one it was opened from.
   * Optional so a synthesized ProjectInfo (tests, harnesses) stays valid.
   */
  manifestFile?: string
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

/**
 * Where an update check got to. `available` carries a URL rather than a
 * download, because the artifacts are not signed yet and electron-updater's
 * integrity check is signature verification (F-10) — see main/updater.ts.
 */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'current' | 'error' | 'unsupported'
  version?: string
  url?: string
  message?: string
  /** 0–100 while downloading. */
  percent?: number
  /** Download rate, for the line under the bar. */
  bytesPerSecond?: number
  /** The version named is a pre-release, so the UI can say "beta" out loud. */
  beta?: boolean
  /**
   * Whether this platform can apply an update at all. False on macOS, where
   * Squirrel.Mac refuses an update that is not signed by the running app's team —
   * so the button opens the release page instead of promising an install.
   */
  canInstall?: boolean
}

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
  | 'file.importImage'
  | 'file.importModel'
  | 'file.importSvg'
  | 'file.importFig'
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
  | 'view.zoomSelection'
  | 'view.zoomActual'
  | 'view.toggleGrid'
  | 'view.toggleRulers'
  | 'view.toggleGpu'
  | 'object.group'
  | 'object.ungroup'
  | 'object.frameSelection'
  | 'object.rotate90'
  | 'object.flipH'
  | 'object.flipV'
  | 'object.bringForward'
  | 'object.sendBackward'
  | 'object.bringToFront'
  | 'object.sendToBack'
  | 'object.flatten'
  | 'object.carve'
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
  | 'help.licenses'
  | 'help.checkUpdates'

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
  /** Opens the shipped THIRD-PARTY-NOTICES.md in the OS default viewer. */
  openLicenses: () => Promise<boolean>
  /**
   * The shell handed us a project to open — a double-clicked `<Name>.poly`, an
   * "Open with", or a second launch while this one is running. Main sends the
   * path and the renderer runs its normal open flow.
   */
  onOpenProjectPath: (cb: (bundlePath: string) => void) => () => void
  /** Ask GitHub whether a newer release exists. Never installs — see updater.ts. */
  checkUpdates: () => Promise<UpdateStatus>
  openReleases: () => Promise<void>
  /** Persisted preference; OFF by default, because a launch-time web call is not free. */
  updateOnLaunch: (enabled?: boolean) => Promise<boolean>
  /** Read (no argument) or set the beta/pre-release opt-in. */
  updateBeta: (enabled?: boolean) => Promise<boolean>
  /** Read (no argument) or set "download and install automatically". */
  updateAutoInstall: (enabled?: boolean) => Promise<boolean>
  /** The status right now, for a window that missed the event. */
  updateStatusNow: () => Promise<UpdateStatus>
  /** Fetch the update the last check found; progress arrives on update:status. */
  downloadUpdate: () => Promise<UpdateStatus>
  /** Quit and apply what was downloaded. */
  installUpdate: () => Promise<UpdateStatus>
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void
  historyAppend: (label: string, opsJson: string) => Promise<number>
  historySetCursor: (cursor: number) => Promise<void>
  assetsImportDialog: (kind?: 'image' | 'model') => Promise<ImportedAsset[] | null>
  assetsRead: (hash: string) => Promise<AssetData | null>
  svgImportDialog: () => Promise<{ fileName: string; text: string }[] | null>
  /**
   * Pick `.fig` files and get them DECODED: main owns this half because the
   * container needs zlib and Zstandard, which the sandboxed renderer has not got.
   * `root` is the decoded document; mapping it to nodes happens in the renderer.
   */
  figImportDialog: (paths?: string[]) => Promise<
    { fileName: string; version: number; root: unknown; images: Record<string, Uint8Array>; error?: string }[] | null
  >
  /** Pick a .poly bundle to attach as a library. */
  libraryPick: () => Promise<{ path: string; title: string } | null>
  /** Read a library bundle's manifest + scene bytes. */
  libraryRead: (path: string) => Promise<{ title: string; sceneBytes: Uint8Array; updatedAt: string } | null>
  /** Pick and read a plugin script (.js). */
  pluginOpenDialog: () => Promise<{ fileName: string; text: string } | null>
  exportSave: (defaultName: string, kind: 'png' | 'svg', data: Uint8Array) => Promise<string | null>
  /**
   * Write several exports into one chosen folder, returning it. Names are
   * flattened to a basename by the main process — a plugin can reach this.
   */
  exportSaveAll: (files: { name: string; data: Uint8Array }[]) => Promise<string | null>
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
