// The offscreen 3D render island (ADR-020).
//
// One hidden WebGL2 canvas renders every MODEL3D node on demand: three.js
// for GLB meshes (PBR against a procedurally generated environment) and
// Spark for gaussian splats. Nothing here touches the document or either
// IRenderer backend — callers get an ImageBitmap and composite it through
// the ordinary image path.
//
// three + Spark are ~6.5 MB, so every import in this module is dynamic:
// the chunk loads the first time a document actually contains a model.

import type * as ThreeNS from 'three'
import type { SparkRenderer as SparkRendererT, SplatMesh as SplatMeshT } from '@sparkjsdev/spark'
import type { LightingPreset, Model3dFormat, ModelPose } from '../engine/types'

/** Snapshots never exceed this on a side (same cap as baked fx layers). */
export const MAX_SNAPSHOT_PX = 2048

export interface RenderRequest {
  bytes: Uint8Array
  format: Model3dFormat
  pose: ModelPose
  lighting: LightingPreset
  upright: boolean
  width: number
  height: number
}

const SPLAT_FORMATS: ReadonlySet<Model3dFormat> = new Set<Model3dFormat>(['PLY', 'SPZ', 'SPLAT', 'KSPLAT', 'SOG'])

export function isSplatFormat(format: Model3dFormat): boolean {
  return SPLAT_FORMATS.has(format)
}

interface Mods {
  THREE: typeof ThreeNS
  GLTFLoader: typeof import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader
  RoomEnvironment: typeof import('three/examples/jsm/environments/RoomEnvironment.js').RoomEnvironment
  SparkRenderer: typeof SparkRendererT
  SplatMesh: typeof SplatMeshT
}

let modsPromise: Promise<Mods> | null = null

function loadMods(): Promise<Mods> {
  modsPromise ??= (async () => {
    const [THREE, gltf, room, spark] = await Promise.all([
      import('three'),
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three/examples/jsm/environments/RoomEnvironment.js'),
      import('@sparkjsdev/spark'),
    ])
    return {
      THREE,
      GLTFLoader: gltf.GLTFLoader,
      RoomEnvironment: room.RoomEnvironment,
      SparkRenderer: spark.SparkRenderer,
      SplatMesh: spark.SplatMesh,
    }
  })()
  return modsPromise
}

/** A loaded model, cached by asset hash across poses and sizes. */
interface LoadedModel {
  object: ThreeNS.Object3D
  /** Bounding sphere in object space, used to auto-frame the camera. */
  center: ThreeNS.Vector3
  radius: number
  splat: boolean
  dispose(): void
}

function disposeObject(THREE: typeof ThreeNS, root: ThreeNS.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as ThreeNS.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const mat = mesh.material
    if (!mat) return
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      for (const value of Object.values(m as unknown as Record<string, unknown>)) {
        if (value instanceof THREE.Texture) value.dispose()
      }
      m.dispose()
    }
  })
}

class Island {
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: ThreeNS.WebGLRenderer
  private readonly pmrem: ThreeNS.PMREMGenerator
  private readonly envs = new Map<LightingPreset, ThreeNS.Texture>()
  private readonly models = new Map<string, LoadedModel>()
  private spark: SparkRendererT | null = null
  private size = { w: 0, h: 0 }

  constructor(private readonly m: Mods) {
    const THREE = m.THREE
    this.canvas = document.createElement('canvas')
    // MSAA stays on: it visibly helps mesh silhouettes, and snapshots are
    // not frame-budget-bound. Spark recommends antialias:false for splat
    // frame rate — revisit if orbit profiling on big captures demands it.
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    })
    this.renderer.setClearColor(0x000000, 0)
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
  }

  /** Procedural environments — no HDRI assets ship with the app. */
  private env(preset: LightingPreset): ThreeNS.Texture | null {
    if (preset === 'NONE') return null
    const cached = this.envs.get(preset)
    if (cached) return cached
    const THREE = this.m.THREE
    let texture: ThreeNS.Texture
    if (preset === 'STUDIO') {
      texture = this.pmrem.fromScene(new this.m.RoomEnvironment(), 0.04).texture
    } else {
      // A tiny equirectangular gradient, PMREM-filtered like any HDRI.
      const w = 64
      const h = 32
      const data = new Float32Array(w * h * 4)
      for (let y = 0; y < h; y++) {
        const v = y / (h - 1)
        for (let x = 0; x < w; x++) {
          const u = x / (w - 1)
          let r: number
          let g: number
          let b: number
          if (preset === 'NEUTRAL') {
            // Even overcast sky: bright above, dim below.
            const l = 1.15 - 0.85 * v
            r = g = b = l
          } else {
            // DRAMATIC: dark surround with one hot key high on the left.
            const du = Math.min(Math.abs(u - 0.28), 1 - Math.abs(u - 0.28))
            const key = Math.exp(-((du * du) / 0.006 + ((v - 0.24) * (v - 0.24)) / 0.01))
            r = 0.06 + 7 * key
            g = 0.06 + 6.7 * key
            b = 0.08 + 6.4 * key
          }
          const i = (y * w + x) * 4
          data[i] = r
          data[i + 1] = g
          data[i + 2] = b
          data[i + 3] = 1
        }
      }
      const src = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType)
      src.mapping = THREE.EquirectangularReflectionMapping
      src.needsUpdate = true
      texture = this.pmrem.fromEquirectangular(src).texture
      src.dispose()
    }
    this.envs.set(preset, texture)
    return texture
  }

  private async load(key: string, bytes: Uint8Array, format: Model3dFormat): Promise<LoadedModel> {
    const existing = this.models.get(key)
    if (existing) return existing
    const THREE = this.m.THREE
    let model: LoadedModel

    if (isSplatFormat(format)) {
      const mesh: SplatMeshT = new this.m.SplatMesh({
        fileBytes: bytes,
        fileName: `model.${format.toLowerCase()}`,
      })
      await mesh.initialized
      const box = mesh.getBoundingBox(true)
      const sphere = box.getBoundingSphere(new THREE.Sphere())
      model = {
        object: mesh,
        center: sphere.center,
        radius: sphere.radius || 1,
        splat: true,
        dispose: () => mesh.dispose(),
      }
    } else {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      const gltf = await new this.m.GLTFLoader().parseAsync(buffer, '')
      const root = gltf.scene
      const box = new THREE.Box3().setFromObject(root)
      const sphere = box.getBoundingSphere(new THREE.Sphere())
      model = {
        object: root,
        center: sphere.center,
        radius: sphere.radius || 1,
        splat: false,
        dispose: () => disposeObject(THREE, root),
      }
    }

    // Bounded cache: models are megabytes of GPU memory apiece.
    while (this.models.size >= 6) {
      const oldest = this.models.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.models.get(oldest)?.dispose()
      this.models.delete(oldest)
    }
    this.models.set(key, model)
    return model
  }

  private resize(w: number, h: number): void {
    if (this.size.w === w && this.size.h === h) return
    this.renderer.setSize(w, h, false)
    this.size = { w, h }
  }

  /** Wait for Spark's async sort to settle so the snapshot is complete. */
  private async settleSplats(scene: ThreeNS.Scene, camera: ThreeNS.Camera): Promise<void> {
    const spark = this.spark
    if (!spark) return
    for (let frame = 0; frame < 120; frame++) {
      this.renderer.render(scene, camera)
      if (frame > 0 && !spark.sorting && !spark.sortDirty) return
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
    }
  }

  async render(key: string, req: RenderRequest): Promise<ImageBitmap> {
    const THREE = this.m.THREE
    const width = Math.max(1, Math.min(MAX_SNAPSHOT_PX, Math.round(req.width)))
    const height = Math.max(1, Math.min(MAX_SNAPSHOT_PX, Math.round(req.height)))
    this.resize(width, height)

    const model = await this.load(key, req.bytes, req.format)
    const scene = new THREE.Scene()

    // Splats carry baked radiance: environment lighting and tone mapping
    // would falsify their captured colors, so both are off for them.
    if (model.splat) {
      this.renderer.toneMapping = THREE.NoToneMapping
      this.spark ??= new this.m.SparkRenderer({ renderer: this.renderer })
      this.spark.minSortIntervalMs = 0
      scene.add(this.spark)
      // Splat captures are stored Y-down (the 3DGS convention); every
      // viewer flips them upright. `upright` lets an odd capture opt out.
      model.object.quaternion.set(req.upright ? 1 : 0, 0, 0, req.upright ? 0 : 1)
    } else {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping
      this.renderer.toneMappingExposure = 1
      scene.environment = this.env(req.lighting)
      if (req.lighting === 'NONE') {
        scene.add(new THREE.AmbientLight(0xffffff, 3))
      } else if (req.lighting === 'DRAMATIC') {
        const key1 = new THREE.DirectionalLight(0xfff2e0, 3.2)
        key1.position.set(-1.4, 1.6, 0.9)
        const rim = new THREE.DirectionalLight(0x9fc4ff, 1.1)
        rim.position.set(1.2, -0.4, -1.4)
        scene.add(key1, rim)
      }
      model.object.quaternion.identity()
    }
    scene.add(model.object)

    const fov = req.pose.fov
    const camera = new THREE.PerspectiveCamera(fov, width / height, 0.01, 1000)
    // Frame the bounding sphere on whichever axis is tighter, then apply
    // the user's distance multiplier.
    const vFov = THREE.MathUtils.degToRad(fov)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (width / height))
    const fit = model.radius / Math.sin(Math.min(vFov, hFov) / 2)
    const yaw = THREE.MathUtils.degToRad(req.pose.yaw)
    const pitch = THREE.MathUtils.degToRad(Math.max(-89.9, Math.min(89.9, req.pose.pitch)))
    const dir = new THREE.Vector3(
      Math.cos(pitch) * Math.sin(yaw),
      Math.sin(pitch),
      Math.cos(pitch) * Math.cos(yaw),
    )
    const target = model.center.clone()
    if (model.splat && req.upright) target.set(target.x, -target.y, -target.z)
    camera.position.copy(target).addScaledVector(dir, fit * req.pose.distance)
    camera.lookAt(target)
    camera.near = Math.max(0.001, fit * req.pose.distance - model.radius * 2)
    camera.far = fit * req.pose.distance + model.radius * 4
    camera.updateProjectionMatrix()

    if (model.splat) {
      await this.settleSplats(scene, camera)
    } else {
      this.renderer.render(scene, camera)
    }

    const bitmap = await createImageBitmap(this.canvas)
    // The model lives in the cache, not the scene: detach so the next
    // render starts from a clean graph.
    scene.remove(model.object)
    if (this.spark) scene.remove(this.spark)
    return bitmap
  }

  dropModel(key: string): void {
    this.models.get(key)?.dispose()
    this.models.delete(key)
  }
}

let islandPromise: Promise<Island> | null = null

function getIsland(): Promise<Island> {
  islandPromise ??= loadMods().then((m) => new Island(m))
  return islandPromise
}

/** Render one model view offscreen. `key` identifies the model asset. */
export async function renderModel(key: string, req: RenderRequest): Promise<ImageBitmap> {
  const island = await getIsland()
  return island.render(key, req)
}

/** Forget a cached model (asset replaced or document closed). */
export async function dropModel(key: string): Promise<void> {
  if (!islandPromise) return
  const island = await islandPromise
  island.dropModel(key)
}
