// Polyform main process: window lifecycle, native dialogs, IPC endpoints,
// project persistence, and the local-fonts permission grant.

import { BrowserWindow, app, dialog, ipcMain, session, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { McpGrants, SaveProjectPayload } from '../shared/types'
import { ProjectManager } from './project'
import { parseCliCommand, runCli } from './cli'
import { bgModelEnsure, bgModelRead, bgModelStatus, bgOrtRuntimeRead } from './bgmodel'
import { mcpStart, mcpStop, mcpStatus, mcpSetGrants, onMcpStatus } from './mcp'
import { listRecents, pushRecent } from './recents'
import { installMenu } from './menu'

// NOTE: do NOT force-enable SharedArrayBuffer here. It sounds like a free
// win (threaded WASM inference), but ort's threaded runtime then uses
// SHARED wasm memory whose growth ceiling is lower than non-shared memory
// — large models (BiRefNet-class) hit std::bad_alloc even at one thread,
// while the non-shared build fits. Measured 2026-08-02 (ADR-019).

const projects = new ProjectManager()
let mainWindow: BrowserWindow | null = null
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

function windowTitle(): string {
  const title = projects.current?.manifest.title
  const dot = isDirty ? ' •' : ''
  return title ? `${title}${dot} — Polyform` : 'Polyform'
}

function refreshTitle(): void {
  mainWindow?.setTitle(windowTitle())
}

function createWindow(hidden = false): void {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#1e1e1e',
    title: 'Polyform',
    show: false,
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
        title: 'Open Polyform Project (.poly folder)',
        defaultPath: app.getPath('documents'),
        properties: ['openDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) return null
      bundlePath = result.filePaths[0]
    }
    try {
      await fs.access(path.join(bundlePath, 'manifest.json'))
    } catch {
      // Headless mode must NEVER raise a dialog — a modal on a hidden
      // window blocks the process and lands on the user's screen (it did).
      failOpen('Not a Polyform project', `The selected folder does not contain a manifest.json:\n${bundlePath}`)
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

  ipcMain.handle('recents:list', () => listRecents())

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
      title: kind === 'model' ? 'Place 3D Model' : 'Place Image',
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
      const slow = method.startsWith('render.') || method.startsWith('asset.') || method.startsWith('bg.')
      const timeout = slow ? 60_000 : 10_000
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

  ipcMain.handle('library:pick', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach Library (.poly folder)',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const libPath = result.filePaths[0]
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(libPath, 'manifest.json'), 'utf-8'))
      return { path: libPath, title: String(manifest.title ?? path.basename(libPath)) }
    } catch {
      dialog.showErrorBox('Not a Polyform project', `No manifest.json found in:\n${libPath}`)
      return null
    }
  })

  ipcMain.handle('library:read', async (_e, libPath: string) => {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(libPath, 'manifest.json'), 'utf-8'))
      const sceneBytes = new Uint8Array(await fs.readFile(path.join(libPath, 'scene.bin')))
      return {
        title: String(manifest.title ?? path.basename(libPath)),
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
