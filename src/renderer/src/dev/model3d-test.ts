// v0.5 spike 6.1 throwaway prototype (POLYFORM_3D_TEST=1). Validates the
// offscreen-island architecture before ADR-020 is committed: three.js
// WebGLRenderer renders a GLB (round-tripped through GLTFExporter →
// GLTFLoader bytes, so no binary fixture ships) and Spark renders a
// synthetic INRIA-format gaussian-splat PLY, both on one hidden WebGL2
// canvas. Each frame is composited through the ImageBitmap → Canvas2D
// path a MODEL3D node would use. Logs MODEL3D_TEST lines, ends with
// MODEL3D_TEST_DONE result=PASS/FAIL.

import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import { SceneGraph } from '../engine/scene'
import { SpatialIndex } from '../engine/spatial-index'
import { createNode } from '../engine/types'
import type { Model3dFormat, Model3dNode } from '../engine/types'
import { renderNodesToCanvas } from '../engine/render/canvas2d'
import { assetCache } from '../engine/assets'
import {
  getSnapshot,
  requestSnapshot,
  settleSnapshots,
  snapshotError,
  snapshotSpec,
} from '../render3d/snapshots'

const W = 512
const H = 512

function log(msg: string): void {
  console.log(`MODEL3D_TEST ${msg}`)
}

/** The exact composite path a MODEL3D node will use: GL canvas →
 *  ImageBitmap → Canvas2D drawImage → pixels. Returns pixel data + ms. */
async function snapshot(gl: HTMLCanvasElement): Promise<{ data: Uint8ClampedArray; ms: number }> {
  const t0 = performance.now()
  const bmp = await createImageBitmap(gl)
  const out = new OffscreenCanvas(W, H)
  const ctx = out.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const data = ctx.getImageData(0, 0, W, H).data
  return { data, ms: performance.now() - t0 }
}

function probe(data: Uint8ClampedArray, x: number, y: number): [number, number, number, number] {
  const i = (y * W + x) * 4
  return [data[i], data[i + 1], data[i + 2], data[i + 3]]
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()))
}

/** Synthesize a minimal INRIA-format binary splat PLY: a fibonacci-sphere
 *  shell of warm-orange gaussians. Property names/semantics per the 3DGS
 *  reference implementation (f_dc = SH DC coeffs, opacity = logit,
 *  scale = ln(sigma), rot = wxyz quaternion). */
function makeSplatPly(count: number): Uint8Array {
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
  const header =
    ['ply', 'format binary_little_endian 1.0', `element vertex ${count}`, ...props.map((p) => `property float ${p}`), 'end_header', ''].join('\n')
  const headerBytes = new TextEncoder().encode(header)
  const stride = props.length * 4
  const body = new DataView(new ArrayBuffer(count * stride))
  const SH_C0 = 0.28209479177387814
  const [r, g, b] = [0.886, 0.341, 0.298]
  const GOLDEN = Math.PI * (1 + Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count
    const phi = Math.acos(1 - 2 * t)
    const theta = GOLDEN * i
    const vals = [
      0.8 * Math.sin(phi) * Math.cos(theta),
      0.8 * Math.cos(phi),
      0.8 * Math.sin(phi) * Math.sin(theta),
      0, 0, 0,
      (r - 0.5) / SH_C0, (g - 0.5) / SH_C0, (b - 0.5) / SH_C0,
      7, // sigmoid(7) ≈ 0.999 opacity
      Math.log(0.07), Math.log(0.07), Math.log(0.07),
      1, 0, 0, 0,
    ]
    for (let p = 0; p < vals.length; p++) body.setFloat32(i * stride + p * 4, vals[p], true)
  }
  const bytes = new Uint8Array(headerBytes.length + body.byteLength)
  bytes.set(headerBytes, 0)
  bytes.set(new Uint8Array(body.buffer), headerBytes.length)
  return bytes
}

async function testGlb(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement): Promise<boolean> {
  // Author a PBR scene, export to GLB bytes, reimport — proving the real
  // user path (arbitrary GLB bytes from disk) without shipping a fixture.
  const source = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.7, 0.28, 128, 32),
    new THREE.MeshStandardMaterial({ color: 0xe2574c, roughness: 0.3, metalness: 0.7 }),
  )
  let t0 = performance.now()
  const glb = (await new GLTFExporter().parseAsync(source, { binary: true })) as ArrayBuffer
  log(`glb export ${glb.byteLength}b in ${(performance.now() - t0).toFixed(0)}ms`)

  t0 = performance.now()
  const gltf = await new GLTFLoader().parseAsync(glb, '')
  const parseMs = performance.now() - t0

  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.add(gltf.scene)
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.01, 100)
  camera.position.set(0, 0, 3.2)
  camera.lookAt(0, 0, 0)

  t0 = performance.now()
  renderer.render(scene, camera)
  const renderMs = performance.now() - t0
  const shot = await snapshot(canvas)
  // The knot is hollow at dead center — gate on opaque coverage across the
  // frame and probe color at the strongest pixel instead.
  let opaque = 0
  let maxA = 0
  let maxI = 0
  for (let i = 3; i < shot.data.length; i += 4) {
    const a = shot.data[i]
    if (a > 200) opaque++
    if (a > maxA) {
      maxA = a
      maxI = i - 3
    }
  }
  const coverage = opaque / (W * H)
  const px = [shot.data[maxI], shot.data[maxI + 1], shot.data[maxI + 2], maxA]
  const corner = probe(shot.data, 8, 8)
  log(`glb parse=${parseMs.toFixed(0)}ms render=${renderMs.toFixed(1)}ms snapshot=${shot.ms.toFixed(1)}ms`)
  log(`glb coverage=${(coverage * 100).toFixed(1)}% strongest=[${px.join(',')}] corner=[${corner.join(',')}]`)

  const pass = coverage > 0.05 && px[0] > px[2] && corner[3] === 0
  log(`glb gates: coverage>5% ${coverage > 0.05 ? 'PASS' : 'FAIL'}; red-dominant ${px[0] > px[2] ? 'PASS' : 'FAIL'}; transparent-bg ${corner[3] === 0 ? 'PASS' : 'FAIL'}`)

  pmrem.dispose()
  source.geometry.dispose()
  return pass
}

async function testSplats(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement): Promise<boolean> {
  const ply = makeSplatPly(4000)
  log(`splat ply synthesized ${ply.byteLength}b`)

  const scene = new THREE.Scene()
  const spark = new SparkRenderer({ renderer })
  scene.add(spark)
  const t0 = performance.now()
  const mesh = new SplatMesh({ fileBytes: ply, fileName: 'synthetic.ply' })
  scene.add(mesh)
  await mesh.initialized
  log(`splat mesh initialized in ${(performance.now() - t0).toFixed(0)}ms`)

  const camera = new THREE.PerspectiveCamera(40, W / H, 0.01, 100)
  camera.position.set(0, 0, 3.2)
  camera.lookAt(0, 0, 0)

  // Spark sorts asynchronously in its worker: render frames until the
  // splats land (measures sort latency), cap at 120 frames.
  let center: [number, number, number, number] = [0, 0, 0, 0]
  let corner: [number, number, number, number] = [0, 0, 0, 0]
  let frames = 0
  const tSort = performance.now()
  for (; frames < 120; frames++) {
    renderer.render(scene, camera)
    if (frames % 5 === 4) {
      const shot = await snapshot(canvas)
      center = probe(shot.data, W / 2, H / 2)
      corner = probe(shot.data, 8, 8)
      if (center[3] > 100) break
    }
    await nextFrame()
  }
  log(`splat visible after ${frames + 1} frames (${(performance.now() - tSort).toFixed(0)}ms)`)
  log(`splat center=[${center.join(',')}] corner=[${corner.join(',')}]`)

  const pass = center[3] > 100 && center[0] > center[2] && corner[3] === 0
  log(`splat gates: visible-subject ${center[3] > 100 ? 'PASS' : 'FAIL'}; warm-color ${center[0] > center[2] ? 'PASS' : 'FAIL'}; transparent-bg ${corner[3] === 0 ? 'PASS' : 'FAIL'}`)
  return pass
}

/**
 * The integration gate: a MODEL3D node in a real scene, rendered through
 * the production path (snapshot cache → island → Canvas2D drawNode →
 * renderNodesToCanvas, which is also what PNG export uses).
 */
async function testDocumentPath(): Promise<boolean> {
  const scene = new SceneGraph()
  const index = new SpatialIndex()

  // A mesh node and a splat node, each fed synthesized bytes directly so
  // the harness needs no project bundle on disk.
  const source = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.7, 0.28, 128, 32),
    new THREE.MeshStandardMaterial({ color: 0x4ca3e2, roughness: 0.35, metalness: 0.4 }),
  )
  const glb = new Uint8Array(
    (await new GLTFExporter().parseAsync(source, { binary: true })) as ArrayBuffer,
  )
  source.geometry.dispose()
  const ply = makeSplatPly(3000)

  const cases: Array<{ name: string; format: Model3dFormat; bytes: Uint8Array }> = [
    { name: 'mesh', format: 'GLB', bytes: glb },
    { name: 'splat', format: 'PLY', bytes: ply },
  ]

  let allPass = true
  for (const [i, c] of cases.entries()) {
    const node = createNode('MODEL3D', c.name) as Model3dNode
    node.assetHash = `${'0'.repeat(48)}${c.name.padEnd(16, 'x')}`
    node.format = c.format
    node.width = 256
    node.height = 256
    node.x = i * 300
    node.y = 0
    scene.addNode(node, null, i)
    index.sync(scene)

    const spec = snapshotSpec(node, node.width, node.height, 1)
    const t0 = performance.now()
    requestSnapshot(spec, async () => c.bytes)
    await settleSnapshots()
    const err = snapshotError(spec)
    if (err) {
      log(`doc ${c.name}: FAIL snapshot error: ${err}`)
      allPass = false
      continue
    }
    const renderMs = performance.now() - t0

    const out = renderNodesToCanvas(scene, index, [node.id], 1, assetCache, null)
    if (!out) {
      log(`doc ${c.name}: FAIL no canvas`)
      allPass = false
      continue
    }
    const data = out.getContext('2d')!.getImageData(0, 0, out.width, out.height).data
    let opaque = 0
    let grey = 0
    for (let p = 0; p < data.length; p += 4) {
      if (data[p + 3] > 180) opaque++
      // The placeholder is a flat 50% grey at 35% alpha — detect it so a
      // "rendered" pass can't be faked by the miss path.
      if (Math.abs(data[p + 3] - 89) < 6 && Math.abs(data[p] - 128) < 6) grey++
    }
    const coverage = opaque / (out.width * out.height)
    const placeholder = grey / (out.width * out.height) > 0.5
    const pass = coverage > 0.05 && !placeholder
    log(
      `doc ${c.name}: ${out.width}x${out.height} coverage=${(coverage * 100).toFixed(1)}% ` +
        `placeholder=${placeholder} render=${renderMs.toFixed(0)}ms -> ${pass ? 'PASS' : 'FAIL'}`,
    )
    if (!pass) allPass = false
  }

  // A cached snapshot must serve the same view without re-rendering.
  const first = scene.rootIds()[0]
  const node = scene.requireNode(first) as Model3dNode
  const cachedSpec = snapshotSpec(node, node.width, node.height, 1)
  const t1 = performance.now()
  const hit = getSnapshot(cachedSpec)
  log(`doc cache: hit=${!!hit} lookup=${(performance.now() - t1).toFixed(2)}ms`)
  if (!hit) allPass = false

  // Orbit responsiveness: the model and its environment are cached, so a
  // new pose costs only render + readback. Roadmap gate: >= 30 fps.
  for (const id of scene.rootIds()) {
    const n = scene.requireNode(id) as Model3dNode
    const times: number[] = []
    const distinct = new Set<ImageBitmap>()
    for (let step = 1; step <= 8; step++) {
      n.camera = { ...n.camera, yaw: n.camera.yaw + 11 * step }
      const spec = snapshotSpec(n, n.width, n.height, 1)
      const t = performance.now()
      requestSnapshot(spec, async () => (n.format === 'GLB' ? glb : ply))
      await settleSnapshots()
      times.push(performance.now() - t)
      const bmp = getSnapshot(spec)
      if (bmp) distinct.add(bmp)
    }
    times.sort((a, b) => a - b)
    const median = times[Math.floor(times.length / 2)]
    const ok = median <= 33.4
    log(
      `orbit ${n.name}: median=${median.toFixed(1)}ms min=${times[0].toFixed(1)} max=${times[times.length - 1].toFixed(1)} ` +
        `(${(1000 / median).toFixed(0)} fps) renders=${distinct.size}/8 ${ok ? 'PASS' : 'BELOW-30FPS'}`,
    )
  }

  return allPass
}

export async function runModel3dTest(): Promise<void> {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    })
    renderer.setSize(W, H, false)
    renderer.setClearColor(0x000000, 0)
    const gl = renderer.getContext()
    log(`context ${gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl1'}`)

    const glbPass = await testGlb(renderer, canvas)
    const splatPass = await testSplats(renderer, canvas)
    renderer.dispose()
    const docPass = await testDocumentPath()

    log(`MODEL3D_TEST_DONE result=${glbPass && splatPass && docPass ? 'PASS' : 'FAIL'}`)
  } catch (err) {
    log(`FATAL ${String(err)}`)
    log('MODEL3D_TEST_DONE result=FAIL')
  }
}
