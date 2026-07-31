// .poly bundle management: manifest.json + scene.bin + history.sqlite +
// assets/ (SHA-256 content-addressed). All writes are atomic (tmp + rename).

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type {
  ImportedAsset,
  JournalState,
  ProjectInfo,
  ProjectManifest,
  SaveProjectPayload,
  ViewportState,
} from '../shared/types'
import { HistoryDb } from './history-db'

const MANIFEST_VERSION = '1.0.0'

function nowIso(): string {
  return new Date().toISOString()
}

function defaultViewport(): ViewportState {
  return { zoom: 1, pan_x: 0, pan_y: 0 }
}

async function writeFileAtomic(filePath: string, data: Buffer | string): Promise<void> {
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, data)
  try {
    await fs.rename(tmp, filePath)
  } catch {
    await fs.rm(filePath, { force: true })
    await fs.rename(tmp, filePath)
  }
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

export class ProjectManager {
  current: ProjectInfo | null = null
  readonly history = new HistoryDb()

  get bundlePath(): string | null {
    return this.current?.path ?? null
  }

  async create(bundlePath: string, title: string): Promise<{ info: ProjectInfo; journal: JournalState }> {
    await this.closeCurrent()
    const normalized = bundlePath.endsWith('.poly') ? bundlePath : `${bundlePath}.poly`
    await fs.mkdir(normalized, { recursive: true })
    await fs.mkdir(path.join(normalized, 'assets'), { recursive: true })
    const manifest: ProjectManifest = {
      version: MANIFEST_VERSION,
      app_build: app.getVersion(),
      project_id: randomUUID(),
      title,
      created_at: nowIso(),
      updated_at: nowIso(),
      viewport_state: defaultViewport(),
    }
    await writeFileAtomic(path.join(normalized, 'manifest.json'), JSON.stringify(manifest, null, 2))
    const journal = await this.history.open(normalized)
    this.current = { path: normalized, manifest }
    return { info: this.current, journal }
  }

  async open(bundlePath: string): Promise<{ info: ProjectInfo; sceneBytes: Uint8Array | null; journal: JournalState }> {
    await this.closeCurrent()
    const manifestRaw = await fs.readFile(path.join(bundlePath, 'manifest.json'), 'utf-8')
    const manifest = JSON.parse(manifestRaw) as ProjectManifest
    if (!manifest.viewport_state) manifest.viewport_state = defaultViewport()
    let sceneBytes: Uint8Array | null = null
    try {
      const buf = await fs.readFile(path.join(bundlePath, 'scene.bin'))
      sceneBytes = new Uint8Array(buf)
    } catch {
      sceneBytes = null
    }
    const journal = await this.history.open(bundlePath)
    this.current = { path: bundlePath, manifest }
    return { info: this.current, sceneBytes, journal }
  }

  async save(payload: SaveProjectPayload): Promise<ProjectInfo> {
    if (!this.current) throw new Error('No project open')
    const dir = this.current.path
    await writeFileAtomic(path.join(dir, 'scene.bin'), Buffer.from(payload.sceneBytes))
    this.current.manifest.updated_at = nowIso()
    this.current.manifest.viewport_state = payload.viewport
    this.current.manifest.app_build = app.getVersion()
    await writeFileAtomic(path.join(dir, 'manifest.json'), JSON.stringify(this.current.manifest, null, 2))
    if (payload.thumbnailPng && payload.thumbnailPng.byteLength > 0) {
      await writeFileAtomic(path.join(dir, 'thumbnail.png'), Buffer.from(payload.thumbnailPng))
    }
    await this.history.persist()
    return this.current
  }

  /** Copy the whole bundle to a new location and switch to it. */
  async saveAs(newBundlePath: string, payload: SaveProjectPayload, title?: string): Promise<ProjectInfo> {
    if (!this.current) throw new Error('No project open')
    const normalized = newBundlePath.endsWith('.poly') ? newBundlePath : `${newBundlePath}.poly`
    const oldDir = this.current.path
    await this.history.persist()
    await fs.mkdir(normalized, { recursive: true })
    await fs.cp(oldDir, normalized, { recursive: true, force: true })
    // Re-open at the new location with a fresh identity.
    const manifest = { ...this.current.manifest }
    manifest.project_id = randomUUID()
    if (title) manifest.title = title
    await this.history.close()
    this.current = { path: normalized, manifest }
    await this.history.open(normalized)
    await this.save(payload)
    return this.current
  }

  async importAssetFile(filePath: string): Promise<ImportedAsset | null> {
    if (!this.current) return null
    const bytes = await fs.readFile(filePath)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const ext = path.extname(filePath).slice(1).toLowerCase() || 'bin'
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
    const assetsDir = path.join(this.current.path, 'assets')
    await fs.mkdir(assetsDir, { recursive: true })
    const target = path.join(assetsDir, `${hash}.${ext}`)
    try {
      await fs.access(target)
      // Already present — deduplicated by content address.
    } catch {
      await writeFileAtomic(target, bytes)
    }
    return { hash, ext, mime, fileName: path.basename(filePath), bytes: new Uint8Array(bytes) }
  }

  async readAsset(hash: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    if (!this.current || !/^[0-9a-f]{16,64}$/i.test(hash)) return null
    const assetsDir = path.join(this.current.path, 'assets')
    try {
      const files = await fs.readdir(assetsDir)
      const match = files.find((f) => f.startsWith(hash))
      if (!match) return null
      const bytes = await fs.readFile(path.join(assetsDir, match))
      const ext = path.extname(match).slice(1).toLowerCase()
      return { bytes: new Uint8Array(bytes), mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' }
    } catch {
      return null
    }
  }

  async closeCurrent(): Promise<void> {
    await this.history.close()
    this.current = null
  }
}
