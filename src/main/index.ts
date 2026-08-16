// Polyform main process: window lifecycle, native dialogs, IPC endpoints,
// project persistence, and the local-fonts permission grant.

import { BrowserWindow, app, clipboard, dialog, ipcMain, session, shell } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { McpGrants, SaveProjectPayload } from '../shared/types'
import { ProjectManager, resolveBundle } from './project'
import { parseCliCommand, runCli } from './cli'
import { bgModelEnsure, bgModelRead, bgModelStatus, bgOrtRuntimeRead } from './bgmodel'
import { mcpStart, mcpStop, mcpStatus, mcpSetGrants, onMcpStatus } from './mcp'
import { readSettings, writeSettings } from './settings'
import { checkForUpdates, downloadUpdate, installUpdate, openReleasesPage, updateStatus } from './updater'
import { listRecents, pushRecent, readRecentThumbnail } from './recents'
import { clickMenuItem, installMenu } from './menu'

// NOTE: do NOT force-enable SharedArrayBuffer here. It sounds like a free
// win (threaded WASM inference), but ort's threaded runtime then uses
// SHARED wasm memory whose growth ceiling is lower than non-shared memory
// — large models (BiRefNet-class) hit std::bad_alloc even at one thread,
// while the non-shared build fits. Measured 2026-08-02 (ADR-019).

const projects = new ProjectManager()
let mainWindow: BrowserWindow | null = null
/** Height of the custom title bar; the renderer's header must match it. */
const TITLEBAR_HEIGHT = 40
let isDirty = false
let closeConfirmed = false

// Headless CLI (7.4, ADR-023): `polyform new|query|export|mcp serve …`.
// Detected before any window exists; the GUI path is untouched when null.
const cliCommand = parseCliCommand(process.argv)
// In serve mode the REAL stdout belongs to the relay child (it inherits the
// fd and speaks MCP on it). Anything this GUI process would print — ours or
// a dependency's — must go to stderr instead, or it corrupts the protocol.
if (cliCommand?.verb === 'serve') {
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
}
let cliReadyResolve: (() => void) | null = null
const cliReady = new Promise<void>((resolve) => {
  cliReadyResolve = resolve
})
let sceneQueryForCli: ((method: string, params: unknown) => Promise<unknown>) | null = null

/**
 * A project path handed over by the shell: `polyform.exe C:\…\MyPoster.poly`
 * from a double-click or "Open with", or the macOS `open-file` event. Held here
 * until the renderer is ready to be told to load it.
 */
let pendingOpenPath: string | null = null

/** A file argument, as distinct from a CLI verb or a switch. */
function fileArgFrom(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (a.startsWith('-')) continue
    if (a.endsWith('index.js')) continue
    if (/\.poly$/i.test(a) || path.basename(a) === 'manifest.json') return path.resolve(a)
  }
  return null
}

if (!cliCommand) pendingOpenPath = fileArgFrom(process.argv)

// macOS delivers the file this way instead of in argv, and it can arrive BEFORE
// ready — so the listener has to be installed at module scope.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (app.isReady() && mainWindow) openPathInWindow(filePath)
  else pendingOpenPath = filePath
})

/**
 * One instance owns the userData directory (the journal's cache lock among other
 * things), so a second double-click has to hand its path to the first rather
 * than start a rival. NOT taken in CLI mode: `polyform mcp serve` is expected to
 * run many at once, and the gates do exactly that.
 */
if (!cliCommand && !app.requestSingleInstanceLock()) {
  app.quit()
} else if (!cliCommand) {
  app.on('second-instance', (_e, argv) => {
    const file = fileArgFrom(argv)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      if (file) openPathInWindow(file)
    }
  })
}

/**
 * Hand the path to the renderer rather than opening it here: the renderer's own
 * flow already saves a dirty document first, applies the saved viewport and
 * updates recents by calling straight back into `project:open`. Duplicating that
 * in main is how the two paths would start to differ.
 */
function openPathInWindow(inputPath: string): void {
  if (!mainWindow) {
    pendingOpenPath = inputPath
    return
  }
  mainWindow.webContents.send('project:openPath', inputPath)
}

function windowTitle(): string {
  const title = projects.current?.manifest.title
  const dot = isDirty ? ' •' : ''
  return title ? `${title}${dot} — Polyform` : 'Polyform'
}

function refreshTitle(): void {
  mainWindow?.setTitle(windowTitle())
}

/**
 * Window icon for unpackaged runs. Packaged builds take their icon from the
 * executable (electron-builder picks up resources/icon.png), so setting it
 * there would be redundant — but from source the taskbar shows Electron's
 * own default, which is not this app.
 */
function devWindowIcon(): string | undefined {
  if (app.isPackaged) return undefined
  const file = path.join(import.meta.dirname, '../../resources/icon.png')
  return existsSync(file) ? file : undefined
}

function createWindow(hidden = false): void {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#1e1e1e',
    title: 'Polyform',
    icon: devWindowIcon(),
    show: false,
    // Frameless with the OS keeping its window controls: the buttons stay
    // native (snap layouts, hover previews, correct hit targets) while the
    // rest of the bar is ours to draw. Colours match --pf-bg-0 / --pf-text-dim
    // so the overlay is invisible against the app's own header.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 12 } }
      : { titleBarOverlay: { color: '#171717', symbolColor: '#9a9a9a', height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (!hidden) {
    installMenu(mainWindow)
    mainWindow.on('ready-to-show', () => mainWindow?.show())

    // ready-to-show is the ONLY thing that reveals the window, so a load that
    // never paints leaves a running process with no window and no error —
    // indistinguishable from "the app doesn't start". Say what happened.
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 is ERR_ABORTED: a redirect or a reload superseding this load.
      if (!isMainFrame || code === -3) return
      mainWindow?.show()
      failOpen(
        'Polyform could not load its interface',
        `${desc} (${code})\n${url}\n\n` +
          'In development this usually means the Vite dev server is not reachable — ' +
          'check that `npm run dev` printed a URL, and that nothing else holds its port.',
      )
    })

    // Last resort: a window must become visible even if nothing ever paints,
    // because an invisible failure is the one no one can debug.
    //
    // Firing is not by itself a failure — the window appears and works. It
    // means first paint was slower than the deadline, which in development is
    // usually Vite compiling the module graph on demand (three, spark,
    // onnxruntime and the wasm engine are several MB of it). So the deadline is
    // generous when there IS a dev server, tight when there isn't, and the
    // message says how far the load actually got.
    let finishedLoad = false
    mainWindow.webContents.on('did-finish-load', () => {
      finishedLoad = true
      // A project the shell asked for at launch. Only now: the listener that
      // receives it lives in the renderer, so sending it earlier sends it to
      // nobody.
      if (pendingOpenPath) {
        const target = pendingOpenPath
        pendingOpenPath = null
        openPathInWindow(target)
      }
    })
    const paintDeadline = process.env['ELECTRON_RENDERER_URL'] ? 30_000 : 10_000
    const watchdog = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        console.error(
          `[polyform] no first paint after ${paintDeadline / 1000}s — showing the window anyway ` +
            `(document ${finishedLoad ? 'finished loading, so this is a slow first frame' : 'is still loading'})`,
        )
        mainWindow.show()
      }
    }, paintDeadline)
    mainWindow.on('closed', () => clearTimeout(watchdog))
  }

  mainWindow.on('close', (e) => {
    if (closeConfirmed) return
    if (projects.current && isDirty) {
      e.preventDefault()
      mainWindow?.webContents.send('app:request-close')
      // Fail-safe: force close if the renderer never confirms. Generous
      // timeout — the renderer is serializing and writing the document.
      setTimeout(() => {
        if (!closeConfirmed && mainWindow && !mainWindow.isDestroyed()) {
          closeConfirmed = true
          mainWindow.close()
        }
      }, 15000)
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // POLYFORM_RENDER_TEST=1 boots the renderer into the GPU/Canvas2D pixel
  // parity + perf harness (dev/render-test.ts); results go to the console.
  // POLYFORM_GPU=1 force-enables the GPU renderer toggle (smoke tests).
  const params = new URLSearchParams()
  if (process.env['POLYFORM_RENDER_TEST'] === '1') params.set('renderTest', '1')
  if (process.env['POLYFORM_GPU'] === '1') params.set('gpu', '1')
  if (process.env['POLYFORM_BG_TEST'] === '1') params.set('bgTest', '1')
  if (process.env['POLYFORM_3D_TEST'] === '1') params.set('m3dTest', '1')
  if (process.env['POLYFORM_AGENT_TEST'] === '1') params.set('agentTest', '1')
  if (hidden && cliCommand) {
    params.set('cli', '1')
    params.set('cliBundle', cliCommand.bundle)
  }
  const renderTest = params.size > 0 ? `?${params.toString()}` : ''
  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + renderTest)
  } else {
    void mainWindow.loadFile(path.join(import.meta.dirname, '../renderer/index.html'), {
      search: renderTest || undefined,
    })
  }
}

/** Open-failure reporting: dialog in the app, stderr + exit code headless. */
function failOpen(title: string, detail: string): void {
  if (cliCommand) {
    process.stderr.write(`polyform ${cliCommand.verb}: ${title}: ${detail.replace(/\n/g, ' ')}\n`)
    app.exit(1)
    return
  }
  dialog.showErrorBox(title, detail)
}

function setupPermissions(): void {
  const allowed = new Set(['local-fonts', 'clipboard-sanitized-write', 'clipboard-read'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}

function registerIpc(): void {
  // Harness-only (POLYFORM_AGENT_TEST=1): create a real bundle at a given
  // path with no dialog, so `npm run test:mcp` exercises the true asset
  // pipeline — disk writes included — instead of a faked-in-memory project.
  if (process.env['POLYFORM_AGENT_TEST'] === '1') {
    ipcMain.handle('test:projectCreate', async (_e, dir: string) => {
      const title = path.basename(dir).replace(/\.poly$/i, '')
      const { info, journal } = await projects.create(dir, title)
      isDirty = false
      refreshTitle()
      return { info, sceneBytes: null, journal }
    })
  }

  ipcMain.handle('project:new', async () => {
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Create Polyform Project',
      defaultPath: path.join(app.getPath('documents'), 'Untitled.poly'),
      buttonLabel: 'Create',
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (result.canceled || !result.filePath) return null
    const title = path.basename(result.filePath).replace(/\.poly$/i, '')
    const { info, journal } = await projects.create(result.filePath, title)
    await pushRecent(info.path, info.manifest.title)
    isDirty = false
    closeConfirmed = false
    refreshTitle()
    return { info, sceneBytes: null, journal }
  })

  ipcMain.handle('project:open', async (_e, requestedPath?: string) => {
    if (!mainWindow) return null
    let bundlePath = requestedPath
    if (!bundlePath) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Open Polyform Project',
        defaultPath: app.getPath('documents'),
        // The project FILE is the entry point now. macOS can offer folders in
        // the same dialog and Windows cannot, so elsewhere the file is the way
        // in — and `manifest.json` stays selectable so pre-v0.7 bundles, which
        // have no .poly file inside, can still be opened.
        properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
        filters: [
          { name: 'Polyform Project', extensions: ['poly'] },
          { name: 'Polyform Project (pre-0.7)', extensions: ['json'] },
        ],
      })
      if (result.canceled || result.filePaths.length === 0) return null
      bundlePath = result.filePaths[0]
    }
    try {
      await resolveBundle(bundlePath)
    } catch (err) {
      // Headless mode must NEVER raise a dialog — a modal on a hidden
      // window blocks the process and lands on the user's screen (it did).
      failOpen('Not a Polyform project', String(err instanceof Error ? err.message : err))
      return null
    }
    try {
      const opened = await projects.open(bundlePath)
      // CLI runs shouldn't rewrite the user's recents in the app.
      if (!cliCommand) await pushRecent(opened.info.path, opened.info.manifest.title)
      isDirty = false
      closeConfirmed = false
      refreshTitle()
      return opened
    } catch (err) {
      failOpen('Failed to open project', String(err))
      return null
    }
  })

  ipcMain.handle('project:save', async (_e, payload: SaveProjectPayload) => {
    if (!projects.current) return false
    await projects.save(payload)
    isDirty = false
    refreshTitle()
    return true
  })

  ipcMain.handle('project:saveAs', async (_e, payload: SaveProjectPayload) => {
    if (!mainWindow || !projects.current) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Project As',
      defaultPath: path.join(app.getPath('documents'), `${projects.current.manifest.title} copy.poly`),
      buttonLabel: 'Save',
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (result.canceled || !result.filePath) return null
    const title = path.basename(result.filePath).replace(/\.poly$/i, '')
    const info = await projects.saveAs(result.filePath, payload, title)
    await pushRecent(info.path, info.manifest.title)
    isDirty = false
    refreshTitle()
    return info
  })

  // The custom title bar's menu invokes the NATIVE item by id, so every
  // command keeps exactly one implementation.
  ipcMain.handle('menu:invoke', (_e, id: string) => clickMenuItem(id))

  ipcMain.handle('recents:list', () => listRecents())
  ipcMain.handle('recents:thumbnail', (_e, bundlePath: string) => readRecentThumbnail(bundlePath))
  // Baked in from package.json at build time — see electron.vite.config.ts
  // for why app.getVersion() is the wrong answer when run from source.
  ipcMain.handle('app:version', () => __APP_VERSION__)

  // The MIT licences of everything we bundle have to travel with the binary,
  // and a notice nobody can open is weak compliance — Help → Third-Party
  // Licences opens the shipped file. One resolver, like the WASM assets
  // (F-08): `extraResources` in the electron-builder config puts it beside the
  // app when packaged; from source it sits at the repo root.
  ipcMain.handle('update:check', () => checkForUpdates(true))
  ipcMain.handle('update:openReleases', () => openReleasesPage())
  ipcMain.handle('update:onLaunch', async (_e, enabled?: boolean) => {
    if (typeof enabled === 'boolean') return (await writeSettings({ checkUpdatesOnLaunch: enabled })).checkUpdatesOnLaunch
    return (await readSettings()).checkUpdatesOnLaunch
  })
  ipcMain.handle('update:beta', async (_e, enabled?: boolean) => {
    if (typeof enabled === 'boolean') return (await writeSettings({ betaUpdates: enabled })).betaUpdates
    return (await readSettings()).betaUpdates
  })
  ipcMain.handle('update:autoInstall', async (_e, enabled?: boolean) => {
    if (typeof enabled === 'boolean') return (await writeSettings({ autoInstallUpdates: enabled })).autoInstallUpdates
    return (await readSettings()).autoInstallUpdates
  })
  // The current status, for a window that opened after a check already ran: the
  // header badge cannot learn about a launch check from an event it missed.
  ipcMain.handle('update:statusNow', () => updateStatus())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => installUpdate())

  ipcMain.handle('app:licenses', async () => {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath ?? '', 'THIRD-PARTY-NOTICES.md')]
      : [path.join(import.meta.dirname, '../../THIRD-PARTY-NOTICES.md')]
    for (const file of candidates) {
      if (existsSync(file)) return (await shell.openPath(file)) === '' // '' means the OS opened it
    }
    return false
  })

  ipcMain.handle('history:append', (_e, label: string, opsJson: string) => {
    return projects.history.append(label, opsJson)
  })

  ipcMain.handle('history:setCursor', (_e, cursor: number) => {
    projects.history.setCursor(cursor)
  })

  ipcMain.handle('assets:importDialog', async (_e, kind: 'image' | 'model' = 'image') => {
    if (!mainWindow || !projects.current) return null
    const filters =
      kind === 'model'
        ? [
            { name: '3D Models', extensions: ['glb', 'gltf', 'ply', 'spz', 'splat', 'ksplat', 'sog'] },
            { name: 'Meshes (glTF)', extensions: ['glb', 'gltf'] },
            { name: 'Gaussian Splats', extensions: ['ply', 'spz', 'splat', 'ksplat', 'sog'] },
          ]
        : [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'] }]
    const result = await dialog.showOpenDialog(mainWindow, {
      title: kind === 'model' ? 'Import 3D Model' : 'Import Image',
      filters,
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const imported = []
    for (const file of result.filePaths) {
      const asset = await projects.importAssetFile(file)
      if (asset) imported.push(asset)
    }
    return imported
  })

  ipcMain.handle('assets:read', (_e, hash: string) => projects.readAsset(hash))

  ipcMain.handle('assets:write', (_e, bytes: Uint8Array, ext: string) =>
    projects.writeAssetBytes(bytes, ext),
  )

  /**
   * What the system clipboard is holding, for paste.
   *
   * The renderer cannot ask: `navigator.clipboard.read()` needs a user gesture
   * the page never sees, because Ctrl+V is claimed by the menu accelerator
   * before it reaches the document — so there is no `paste` event either. This
   * is the only door.
   *
   * PNG whatever it started as: the clipboard holds a bitmap, not a file, so
   * there is no original encoding to preserve.
   */
  ipcMain.handle('clipboard:read', () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return { image: null }
    const size = image.getSize()
    return { image: { bytes: image.toPNG(), width: size.width, height: size.height } }
  })

  /**
   * The native edit action, on whatever has focus.
   *
   * Ctrl+C/V/A are menu accelerators, so they are taken before the page sees
   * them and the app acts on the SELECTED LAYERS however they were pressed —
   * which means paste has never worked inside a text field, and Ctrl+A while
   * renaming a layer selected the whole document. The renderer sends the ones
   * that arrive while a field has focus back here to be performed properly.
   */
  ipcMain.handle('clipboard:nativeEdit', (e, op: 'copy' | 'cut' | 'paste' | 'selectAll') => {
    const wc = e.sender
    if (op === 'copy') wc.copy()
    else if (op === 'cut') wc.cut()
    else if (op === 'paste') wc.paste()
    else wc.selectAll()
  })

  ipcMain.handle('clipboard:writeMarker', (_e, token: string) => {
    // Text, not an image: this only has to be recognisable to us, and harmless
    // to anyone who pastes it somewhere else by accident.
    clipboard.writeText(token)
  })

  // Agent connectivity (v0.6 spike 7.1, ADR-021): a loopback MCP endpoint.
  // The document lives in the renderer, so every tool call round-trips over
  // this one bridge; the main process keeps no scene state of its own.
  let sceneSeq = 0
  const scenePending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  ipcMain.on('mcp:sceneReply', (_e, id: number, ok: boolean, payload: unknown) => {
    const waiter = scenePending.get(id)
    if (!waiter) return
    scenePending.delete(id)
    if (ok) waiter.resolve(payload)
    else waiter.reject(new Error(String(payload)))
  })
  const sceneQuery = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        reject(new Error('Polyform has no window open'))
        return
      }
      const id = ++sceneSeq
      scenePending.set(id, { resolve, reject })
      mainWindow.webContents.send('mcp:sceneRequest', id, method, params)
      // Snapshots rasterize the scene (and may settle 3D first, ADR-020);
      // imports decode multi-MB images; bg removal runs ~5s of inference.
      // All get a longer leash than a structure read.
      //
      // 30s for a structure read, not 10. Raising it did NOT fix the failure it
      // was raised for — that was a dropped-message race in the CLI handshake
      // (F-25), fixed in main.tsx. The longer leash stays on its own merits: the
      // first read after a cold headless boot waits on 2.6 MB of WASM engine
      // with no GPU and an empty disk cache, and a CI runner is slower than the
      // machine this number was first guessed on.
      const slow = method.startsWith('render.') || method.startsWith('asset.') || method.startsWith('bg.')
      const timeout = slow ? 60_000 : 30_000
      setTimeout(() => {
        if (scenePending.delete(id)) reject(new Error(`scene query timed out: ${method}`))
      }, timeout)
    })

  // CLI mode: the hidden renderer opens its bundle through the normal
  // project:open path (which takes an explicit path without a dialog),
  // then signals readiness — after which the CLI verb drives the bridge.
  if (cliCommand) {
    ipcMain.on('cli:ready', () => cliReadyResolve?.())
    sceneQueryForCli = sceneQuery
  }

  ipcMain.handle('mcp:status', () => mcpStatus())
  ipcMain.handle('mcp:start', (_e, grants?: Partial<McpGrants>) => mcpStart(sceneQuery, grants))
  ipcMain.handle('mcp:stop', () => mcpStop())
  ipcMain.handle('mcp:setGrants', (_e, grants: Partial<McpGrants>) => mcpSetGrants(grants))
  // Push status instead of letting the renderer poll: an indicator that only
  // refreshes on a timer is wrong for however long the timer has left.
  onMcpStatus((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mcp:status', status)
  })

  // Background-removal model (v0.4.1, ADR-019): consent-gated download.
  ipcMain.handle('bgmodel:status', () => bgModelStatus())
  ipcMain.handle('bgmodel:ensure', (e) =>
    bgModelEnsure((received, total) => {
      e.sender.send('bgmodel:progress', { received, total })
    }),
  )
  ipcMain.handle('bgmodel:read', () => bgModelRead())
  ipcMain.handle('bgmodel:ort', () => bgOrtRuntimeRead())

  ipcMain.handle('import:svgDialog', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import SVG',
      filters: [{ name: 'SVG Images', extensions: ['svg'] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const files = []
    for (const file of result.filePaths) {
      try {
        const text = await fs.readFile(file, 'utf-8')
        files.push({ fileName: path.basename(file), text })
      } catch {
        /* skip unreadable */
      }
    }
    return files
  })

  /**
   * `.fig` import, split across the boundary at the one place it has to be: the
   * container needs DEFLATE and Zstandard, which live in Node's zlib, and the
   * renderer is sandboxed with no Node at all. So main reads the file and decodes
   * the container + its embedded schema (pure engine code, shared with the
   * renderer), and hands over the decoded document. Mapping it onto our nodes
   * stays in the renderer, where the scene is.
   */
  ipcMain.handle('import:figDialog', async (_e, paths?: string[]) => {
    if (!mainWindow) return null
    let chosen = paths
    if (!chosen || chosen.length === 0) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Import Figma Document',
        filters: [{ name: 'Figma Document', extensions: ['fig'] }],
        properties: ['openFile', 'multiSelections'],
      })
      if (result.canceled || result.filePaths.length === 0) return null
      chosen = result.filePaths
    }
    const { readFig } = await import('../shared/fig/container')
    const zlib = await import('node:zlib')
    const inflators = {
      inflateRaw: (b: Uint8Array) => new Uint8Array(zlib.inflateRawSync(b)),
      zstd: (b: Uint8Array) => new Uint8Array(zlib.zstdDecompressSync(b)),
    }
    const files: { fileName: string; version: number; root: unknown; images: Record<string, Uint8Array>; error?: string }[] = []
    for (const file of chosen) {
      const fileName = path.basename(file)
      try {
        const bytes = new Uint8Array(await fs.readFile(file))
        const doc = readFig(bytes, inflators)
        files.push({
          fileName,
          version: doc.version,
          root: doc.root,
          images: Object.fromEntries(doc.archive.images),
        })
      } catch (err) {
        // Report per file rather than failing the batch: one unreadable export
        // should not stop the others, and the renderer shows the reason.
        files.push({ fileName, version: 0, root: null, images: {}, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return files
  })

  ipcMain.handle('export:save', async (_e, defaultName: string, kind: 'png' | 'svg', data: Uint8Array) => {
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: `Export ${kind.toUpperCase()}`,
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: kind === 'png' ? [{ name: 'PNG Image', extensions: ['png'] }] : [{ name: 'SVG Image', extensions: ['svg'] }],
    })
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, Buffer.from(data))
    return result.filePath
  })

  // Several exports at once: pick the folder once, write them all.
  ipcMain.handle('export:saveAll', async (_e, files: { name: string; data: Uint8Array }[]) => {
    if (!mainWindow || !Array.isArray(files) || files.length === 0) return null
    if (files.length > 64) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `Export ${files.length} files to folder`,
      defaultPath: app.getPath('documents'),
      buttonLabel: 'Export here',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]
    for (const f of files) {
      // Flatten to a basename, then strip what a filename can't contain.
      // Plugin scripts run in the renderer's realm and can reach this channel,
      // so a name must never escape the folder the user picked (F-15) — and an
      // unwritable name must not abort the files after it.
      const safe = path
        .basename(String(f.name ?? ''))
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/^\.+/, '')
      if (!safe) continue
      try {
        await fs.writeFile(path.join(dir, safe), Buffer.from(f.data))
      } catch {
        /* skip this one; the rest still land */
      }
    }
    return dir
  })

  ipcMain.handle('library:pick', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach Library',
      defaultPath: app.getPath('documents'),
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: [
        { name: 'Polyform Project', extensions: ['poly'] },
        { name: 'Polyform Project (pre-0.7)', extensions: ['json'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    try {
      // Through the same resolver as opening a project: a library IS a project,
      // and it may be either bundle shape.
      const { dir, manifestFile } = await resolveBundle(result.filePaths[0])
      const manifest = JSON.parse(await fs.readFile(path.join(dir, manifestFile), 'utf-8'))
      return { path: dir, title: String(manifest.title ?? path.basename(dir)) }
    } catch (err) {
      dialog.showErrorBox('Not a Polyform project', String(err instanceof Error ? err.message : err))
      return null
    }
  })

  ipcMain.handle('library:read', async (_e, libPath: string) => {
    try {
      const { dir, manifestFile } = await resolveBundle(libPath)
      const manifest = JSON.parse(await fs.readFile(path.join(dir, manifestFile), 'utf-8'))
      const sceneBytes = new Uint8Array(await fs.readFile(path.join(dir, 'scene.bin')))
      return {
        title: String(manifest.title ?? path.basename(dir)),
        sceneBytes,
        updatedAt: String(manifest.updated_at ?? ''),
      }
    } catch {
      return null
    }
  })

  ipcMain.handle('plugins:openDialog', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Run Plugin Script',
      filters: [{ name: 'JavaScript', extensions: ['js', 'mjs'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    try {
      const text = await fs.readFile(result.filePaths[0], 'utf-8')
      return { fileName: path.basename(result.filePaths[0]), text }
    } catch {
      return null
    }
  })

  ipcMain.on('app:set-dirty', (_e, dirty: boolean) => {
    isDirty = dirty
    refreshTitle()
  })

  ipcMain.on('app:set-title', () => refreshTitle())

  ipcMain.on('app:confirm-close', () => {
    closeConfirmed = true
    void projects.history.persist().finally(() => {
      mainWindow?.close()
    })
  })
}

app.whenReady().then(async () => {
  // Windows shell identity. This is NOT what makes Task Manager say "Polyform"
  // — that name is the *executable's* version info, so from source it reads
  // "Electron" (the binary is node_modules/electron/dist/electron.exe) and no
  // runtime call can rename it; the packaged Polyform.exe carries our own.
  // What this fixes is identity: without it the window has no AppUserModelID,
  // so the shell falls back to the exe — every unpackaged Electron app shares
  // one taskbar identity, notification toasts are attributed to "Electron",
  // and a pinned shortcut does not recognise the running window as itself. The
  // id has to be the installer's appId, which is why it is a build-time define
  // from the same package.json rather than a string typed twice.
  if (process.platform === 'win32') app.setAppUserModelId(__APP_ID__)

  if (cliCommand) {
    // `new` needs no renderer at all; everything else boots one, hidden.
    if (cliCommand.verb === 'new') {
      try {
        const title = cliCommand.flags.get('title') ?? path.basename(cliCommand.bundle).replace(/\.poly$/i, '')
        const { info } = await projects.create(cliCommand.bundle, title)
        process.stdout.write(info.path + '\n')
        app.exit(0)
      } catch (err) {
        process.stderr.write(`polyform new: ${err instanceof Error ? err.message : String(err)}\n`)
        app.exit(1)
      }
      return
    }
    setupPermissions()
    registerIpc()
    createWindow(true)
    void runCli(cliCommand, {
      projects,
      sceneQuery: (method, params) => sceneQueryForCli!(method, params),
      rendererReady: cliReady,
    })
    return
  }

  setupPermissions()
  registerIpc()
  createWindow()

  // Only if the user turned it on, and never during a CLI run (handled above).
  // Delayed so a network call cannot compete with opening a document, and it
  // reports nothing unless there is something to report.
  void readSettings().then((s) => {
    if (s.checkUpdatesOnLaunch) setTimeout(() => void checkForUpdates(false), 4000)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Never leave the agent endpoint listening once there is no document
  // behind it — a live socket with no window is exactly the F-20 risk.
  void Promise.all([projects.closeCurrent(), mcpStop()]).finally(() => {
    if (process.platform !== 'darwin') app.quit()
  })
})
