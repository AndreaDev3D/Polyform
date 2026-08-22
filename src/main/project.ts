// .poly bundle management: <Name>.poly (the manifest) + scene.bin +
// history.sqlite + assets/ (SHA-256 content-addressed). All writes are atomic
// (tmp + rename).
//
// The bundle is a DIRECTORY and the manifest inside it is the file you
// double-click — the shape .NET, Unity and Godot all use, and the only one that
// works: a folder cannot carry a file association on Windows or Linux, so a
// project that is only a folder can never be opened from a file manager.
//
//   MyPoster/
//     MyPoster.poly     <- JSON manifest, and the entry point
//     scene.bin
//     history.sqlite
//     assets/<sha256>.png
//
// Bundles written before v0.7 are `MyPoster.poly/manifest.json` — a directory
// carrying the extension. Those still open, and still save to the file they were
// found in; nothing is migrated behind the user's back. `resolveBundle` is the
// ONE place that knows both shapes, because three call sites used to hardcode
// `manifest.json` and they would have drifted apart the moment a fourth arrived.

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type {
  ImportedAsset,
  JournalState,
  ProjectInfo,
  ProjectManifest,
  ProjectShaderFile,
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

let tmpCounter = 0

async function writeFileAtomic(filePath: string, data: Buffer | string): Promise<void> {
  // Unique temp name: concurrent writers must never share a staging file.
  const tmp = `${filePath}.${process.pid}.${++tmpCounter}.tmp`
  await fs.writeFile(tmp, data)
  try {
    await fs.rename(tmp, filePath)
  } catch {
    await fs.rm(filePath, { force: true })
    await fs.rename(tmp, filePath)
  }
}

/** Legacy manifest name, still read (and still written for bundles that use it). */
const LEGACY_MANIFEST = 'manifest.json'

export interface ResolvedBundle {
  /** The bundle directory. */
  dir: string
  /** Manifest file NAME inside it — `<Name>.poly`, or `manifest.json` for legacy. */
  manifestFile: string
}

/**
 * Accept whatever a user, a shell association or a CLI argument hands us: the
 * bundle directory, the `<Name>.poly` manifest inside it, or a legacy
 * `manifest.json`.
 */
export async function resolveBundle(inputPath: string): Promise<ResolvedBundle> {
  const abs = path.resolve(inputPath)
  let stat: import('node:fs').Stats | null = null
  try {
    stat = await fs.stat(abs)
  } catch {
    stat = null
  }

  if (stat?.isFile()) {
    const name = path.basename(abs)
    if (name.toLowerCase().endsWith('.poly') || name === LEGACY_MANIFEST) {
      return { dir: path.dirname(abs), manifestFile: name }
    }
    throw new Error(`${name} is not a Polyform project file (expected <Name>.poly)`)
  }

  if (stat?.isDirectory()) {
    const preferred = `${path.basename(abs)}.poly`
    const entries = await fs.readdir(abs)
    // Named after its folder first, then any single .poly, then legacy. Ordered,
    // not guessed: a bundle copied and renamed keeps working, and a folder with
    // two project files is an error rather than a coin toss.
    if (entries.includes(preferred)) return { dir: abs, manifestFile: preferred }
    const polys = entries.filter((e) => e.toLowerCase().endsWith('.poly'))
    if (polys.length === 1) return { dir: abs, manifestFile: polys[0] }
    if (polys.length > 1) {
      throw new Error(`${path.basename(abs)} contains ${polys.length} project files (${polys.join(', ')}) — open one directly`)
    }
    if (entries.includes(LEGACY_MANIFEST)) return { dir: abs, manifestFile: LEGACY_MANIFEST }
    throw new Error(`${path.basename(abs)} is not a Polyform project (no <Name>.poly or ${LEGACY_MANIFEST} inside)`)
  }

  // A path that does not exist, or the pre-v0.7 shape typed from memory:
  // `MyPoster.poly` when the bundle is now `MyPoster/MyPoster.poly`.
  if (abs.toLowerCase().endsWith('.poly')) {
    const stripped = abs.slice(0, -'.poly'.length)
    try {
      if ((await fs.stat(stripped)).isDirectory()) return await resolveBundle(stripped)
    } catch {
      /* fall through to the error below */
    }
  }
  throw new Error(`No Polyform project at ${inputPath}`)
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
  // 3D model containers (v0.5, ADR-020). The renderer parses these itself;
  // the mime types are informational (glTF-Binary is registered, the splat
  // formats have none).
  glb: 'model/gltf-binary',
  ply: 'application/octet-stream',
  spz: 'application/octet-stream',
  splat: 'application/octet-stream',
  ksplat: 'application/octet-stream',
  sog: 'application/octet-stream',
}

export class ProjectManager {
  current: ProjectInfo | null = null
  readonly history = new HistoryDb()

  get bundlePath(): string | null {
    return this.current?.path ?? null
  }

  async create(bundlePath: string, title: string): Promise<{ info: ProjectInfo; journal: JournalState }> {
    await this.closeCurrent()
    // The argument names the PROJECT; a trailing .poly is accepted and dropped,
    // because the extension now belongs to the manifest rather than the folder.
    // `polyform new MyPoster.poly` and `... MyPoster` both make MyPoster/.
    const normalized = bundlePath.replace(/\.poly$/i, '')
    const manifestFile = `${path.basename(normalized)}.poly`
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
    await writeFileAtomic(path.join(normalized, manifestFile), JSON.stringify(manifest, null, 2))
    const journal = await this.history.open(normalized)
    this.current = { path: normalized, manifest, manifestFile }
    return { info: this.current, journal }
  }

  async open(bundlePath: string): Promise<{ info: ProjectInfo; sceneBytes: Uint8Array | null; journal: JournalState }> {
    await this.closeCurrent()
    const { dir, manifestFile } = await resolveBundle(bundlePath)
    const manifestRaw = await fs.readFile(path.join(dir, manifestFile), 'utf-8')
    const manifest = JSON.parse(manifestRaw) as ProjectManifest
    if (!manifest.viewport_state) manifest.viewport_state = defaultViewport()
    let sceneBytes: Uint8Array | null = null
    try {
      const buf = await fs.readFile(path.join(dir, 'scene.bin'))
      sceneBytes = new Uint8Array(buf)
    } catch {
      sceneBytes = null
    }
    const journal = await this.history.open(dir)
    this.current = { path: dir, manifest, manifestFile }
    return { info: this.current, sceneBytes, journal }
  }

  async save(payload: SaveProjectPayload): Promise<ProjectInfo> {
    if (!this.current) throw new Error('No project open')
    const dir = this.current.path
    await writeFileAtomic(path.join(dir, 'scene.bin'), Buffer.from(payload.sceneBytes))
    this.current.manifest.updated_at = nowIso()
    this.current.manifest.viewport_state = payload.viewport
    this.current.manifest.app_build = app.getVersion()
    // Back to the file it was opened from: a legacy bundle keeps its
    // manifest.json rather than silently sprouting a second manifest.
    await writeFileAtomic(path.join(dir, this.current.manifestFile ?? LEGACY_MANIFEST), JSON.stringify(this.current.manifest, null, 2))
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

  /**
   * Read the bundle's shaders/ directory: one subdirectory per shader,
   * carrying shader.json (the manifest) and shader.wgsl (the body).
   *
   * Returns RAW TEXT. Validation — manifest schema, uniform caps, WGSL
   * compilation — belongs to the renderer, which owns the shader registry
   * and can attach an error to the exact shader it names; this side only
   * enforces what a directory listing can lie about: names, sizes, counts.
   * The caps are refusals, not truncations — half a shader is worse than a
   * named error.
   *
   * Reading is on-demand (project open, and the explicit Reload menu
   * action). No watching: ADR-013's import-on-use rule, same as libraries.
   */
  async readProjectShaders(): Promise<ProjectShaderFile[]> {
    if (!this.current) return []
    const root = path.join(this.current.path, 'shaders')
    let entries: string[]
    try {
      entries = (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return [] // no shaders/ directory — the common case, not an error
    }
    const out: ProjectShaderFile[] = []
    for (const name of entries.slice(0, 32).sort()) {
      // The name becomes part of a shader id ("project:<name>") that lands in
      // documents — hold it to the same discipline as asset extensions.
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
        out.push({ name, error: 'shader folder names may only use letters, digits, - and _' })
        continue
      }
      try {
        const manifestPath = path.join(root, name, 'shader.json')
        const wgslPath = path.join(root, name, 'shader.wgsl')
        const [manifestStat, wgslStat] = await Promise.all([fs.stat(manifestPath), fs.stat(wgslPath)])
        if (manifestStat.size > 8 * 1024) {
          out.push({ name, error: 'shader.json is larger than 8 KiB' })
          continue
        }
        if (wgslStat.size > 64 * 1024) {
          out.push({ name, error: 'shader.wgsl is larger than 64 KiB' })
          continue
        }
        const [manifestText, wgsl] = await Promise.all([
          fs.readFile(manifestPath, 'utf-8'),
          fs.readFile(wgslPath, 'utf-8'),
        ])
        out.push({ name, manifestText, wgsl })
      } catch (err) {
        out.push({
          name,
          error: `missing or unreadable shader.json/shader.wgsl (${err instanceof Error ? err.message : String(err)})`,
        })
      }
    }
    return out
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

  /** Write renderer-produced bytes (e.g. a background-removal cutout) as a
   * content-addressed asset; dedupes like importAssetFile. */
  async writeAssetBytes(bytes: Uint8Array, ext: string): Promise<{ hash: string; mime: string } | null> {
    if (!this.current) return null
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : 'bin'
    const buf = Buffer.from(bytes)
    const hash = createHash('sha256').update(buf).digest('hex')
    const assetsDir = path.join(this.current.path, 'assets')
    await fs.mkdir(assetsDir, { recursive: true })
    const target = path.join(assetsDir, `${hash}.${safeExt}`)
    try {
      await fs.access(target)
    } catch {
      await writeFileAtomic(target, buf)
    }
    return { hash, mime: MIME_BY_EXT[safeExt] ?? 'application/octet-stream' }
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
