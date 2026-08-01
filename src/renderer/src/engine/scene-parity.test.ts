// Differential tests: TS SceneGraph + PatchOp engine vs the Rust port
// (crates/polyform-core scene.rs) via the SceneHandle JSON boundary.
//
// Contracts under test (V0.4-Porting-Plan #1 and #2):
// - identical document state after every op batch (deep JSON equality)
// - identical undo results (back to the initial document)
// - identical renderOrder / parentOf / rootIds
// - worldMatrix / worldAABB within transcendental tolerance
// The journal fixture replays through BOTH engines against the same frozen
// snapshot committed by journal-replay.test.ts.

import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { SceneGraph } from './scene'
import { applyOps, makeUpdateOp, removeSubtreeOps, undoOps, type PatchOp } from './commands'
import { createNode, createPage } from './types'
import type { SceneNode } from './types'
import { initWasmEngine, wasmHandle } from './backend'
import { buildJournal, fixedNode, initialDocument } from './journal-fixture'
import type { SceneHandle } from './wasm/pkg/polyform_core'
import { findDropFrame, hitTestAll, nodesInRect, type HitOptions } from './hit-test'
import { SpatialIndex } from './spatial-index'
import { constrainChild, type ChildRect } from './constraints'
import { decodeScene, encodeScene } from './serialization'
import { runDerivedPasses } from './layout'
import { setMaterializeIdFactory } from './components'

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('./wasm/pkg/polyform_core_bg.wasm', import.meta.url))
  const ok = await initWasmEngine(readFileSync(wasmPath))
  expect(ok).toBe(true)
})

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(0x53434547) // 'SCEG'
const range = (lo: number, hi: number) => lo + rand() * (hi - lo)
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]

const jsonDoc = (scene: SceneGraph): unknown => JSON.parse(JSON.stringify(scene.doc))

function expectDocsEqual(handle: SceneHandle, scene: SceneGraph, label: string) {
  expect(JSON.parse(handle.docJson()), label).toEqual(jsonDoc(scene))
}

function expectGeometryEqual(handle: SceneHandle, scene: SceneGraph, label: string) {
  expect(JSON.parse(handle.renderOrder()), `${label}: renderOrder`).toEqual(scene.renderOrder())
  expect(JSON.parse(handle.rootIds()), `${label}: rootIds`).toEqual(scene.rootIds())
  for (const id of Object.keys(scene.doc.nodes)) {
    const tm = scene.worldMatrix(id)
    const wm = handle.worldMatrix(id)
    const te = [tm.a, tm.b, tm.c, tm.d, tm.e, tm.f]
    for (let i = 0; i < 6; i++) {
      const scale = Math.max(1, Math.abs(te[i]))
      expect(
        Math.abs(wm[i] - te[i]) <= 1e-9 * scale,
        `${label}: worldMatrix(${id})[${i}] ${wm[i]} vs ${te[i]}`,
      ).toBe(true)
    }
    expect(JSON.parse(handle.parentOf(id) === undefined ? 'null' : JSON.stringify(handle.parentOf(id))), `${label}: parentOf(${id})`).toEqual(
      scene.parentOf(id),
    )
    const tb = scene.worldAABB(id)
    const wb = handle.worldAabb(id)
    const tbArr = [tb.minX, tb.minY, tb.maxX, tb.maxY]
    for (let i = 0; i < 4; i++) {
      if (!Number.isFinite(tbArr[i])) {
        expect(Number.isFinite(wb[i]), `${label}: worldAABB(${id})[${i}] finiteness`).toBe(false)
        continue
      }
      const scale = Math.max(1, Math.abs(tbArr[i]))
      expect(
        Math.abs(wb[i] - tbArr[i]) <= 1e-9 * scale,
        `${label}: worldAABB(${id})[${i}] ${wb[i]} vs ${tbArr[i]}`,
      ).toBe(true)
    }
  }
}

describe('journal fixture through both engines', () => {
  it('replays, undoes, and redoes identically', () => {
    const initial = initialDocument()
    const scene = new SceneGraph(structuredClone(initial))
    const handle = new (wasmHandle().SceneHandle)(JSON.stringify(initial))

    const entries = buildJournal(scene) // applies to the TS scene as it builds
    for (const ops of entries) handle.applyOps(JSON.stringify(ops))
    expectDocsEqual(handle, scene, 'after replay')
    expectGeometryEqual(handle, scene, 'after replay')

    // The frozen contract snapshot must match the WASM result too.
    const frozen = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('./__fixtures__/journal-replay-final.json', import.meta.url)),
        'utf8',
      ),
    )
    expect(JSON.parse(handle.docJson())).toEqual(frozen)

    for (let i = entries.length - 1; i >= 0; i--) {
      undoOps(scene, entries[i])
      handle.undoOps(JSON.stringify(entries[i]))
    }
    expectDocsEqual(handle, scene, 'after undo-all')
    expect(JSON.parse(handle.docJson())).toEqual(JSON.parse(JSON.stringify(initial)))

    for (const ops of entries) {
      applyOps(scene, ops)
      handle.applyOps(JSON.stringify(ops))
    }
    expectDocsEqual(handle, scene, 'after redo-all')
    handle.free()
  })
})

// ---------------------------------------------------------------------------
// Randomized op fuzz
// ---------------------------------------------------------------------------

let idCounter = 0
const nextId = () => `n${++idCounter}`

function randomNode(): SceneNode {
  const type = pick<SceneNode['type']>([
    'RECTANGLE',
    'ELLIPSE',
    'FRAME',
    'GROUP',
    'STAR',
    'POLYGON',
    'VECTOR',
    'TEXT',
    'LINE',
    'BOOLEAN',
  ])
  const node = fixedNode(type, `Node ${idCounter + 1}`, nextId())
  if (rand() < 0.08) node.locked = true
  node.x = range(-400, 400)
  node.y = range(-400, 400)
  node.width = range(1, 300)
  node.height = range(1, 300)
  if (rand() < 0.3) node.rotation = range(-180, 180)
  if (rand() < 0.25) {
    node.strokes = [
      { type: 'SOLID', visible: true, opacity: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
    ]
    node.strokeWeight = range(0.5, 12)
    node.strokeAlign = pick(['CENTER', 'INSIDE', 'OUTSIDE'])
  }
  if (rand() < 0.2) {
    node.effects = [
      {
        type: 'DROP_SHADOW',
        visible: true,
        color: { r: 0, g: 0, b: 0, a: 0.4 },
        offset: { x: range(-10, 10), y: range(-10, 10) },
        blur: range(0, 16),
      },
    ]
  }
  if (node.type === 'VECTOR') {
    const verts = 3 + Math.floor(rand() * 5)
    node.network = {
      vertices: Array.from({ length: verts }, (_, i) => ({
        id: i,
        x: range(-50, 150),
        y: range(-50, 150),
      })),
      edges: Array.from({ length: verts }, (_, i) => ({
        id: i,
        v0: i,
        v1: (i + 1) % verts,
        cp0: rand() < 0.3 ? { x: range(-50, 150), y: range(-50, 150) } : null,
        cp1: null,
      })),
    }
  }
  if (rand() < 0.3 && !isNaN(0)) node.visible = rand() < 0.85
  return node
}

function randomOps(scene: SceneGraph): PatchOp[] {
  const nodeIds = Object.keys(scene.doc.nodes)
  const containers = nodeIds.filter((id) => {
    const n = scene.getNode(id)
    return n && (n.type === 'FRAME' || n.type === 'GROUP' || n.type === 'BOOLEAN')
  })
  const pages = scene.doc.pages
  const kind = rand()

  // add (weighted heavily early while the doc is small)
  if (kind < 0.45 || nodeIds.length < 5) {
    const node = randomNode()
    const parentChoices: (string | null)[] = [null, ...pages.map((p) => p.id), ...containers]
    const parent = pick(parentChoices)
    const list = scene.childListOf(parent)
    return [{ kind: 'add', parentId: parent, index: Math.floor(rand() * (list.length + 1)), node }]
  }
  // update
  if (kind < 0.7) {
    const id = pick(nodeIds)
    const node = scene.getNode(id)!
    const patchPalette: Record<string, unknown>[] = [
      { x: range(-400, 400), y: range(-400, 400) },
      { width: range(1, 400), height: range(1, 400) },
      { rotation: range(-180, 180) },
      { visible: rand() < 0.8 },
      { opacity: range(0, 1) },
      { name: `Renamed ${Math.floor(rand() * 1000)}` },
      { strokeWeight: range(0, 20), strokeAlign: pick(['CENTER', 'INSIDE', 'OUTSIDE']) },
    ]
    return [makeUpdateOp(node, pick(patchPalette))]
  }
  // move
  if (kind < 0.85 && nodeIds.length > 1) {
    const id = pick(nodeIds)
    const targets: (string | null)[] = [
      null,
      ...pages.map((p) => p.id),
      ...containers.filter((c) => c !== id && !scene.isAncestorOf(id, c)),
    ]
    const to = pick(targets)
    const fromParent = scene.parentOf(id)
    const fromIndex = scene.indexInParent(id)
    const toList = scene.childListOf(to)
    const toIndex = Math.floor(rand() * (toList.length + 1))
    return [
      {
        kind: 'move',
        id,
        from: { parentId: fromParent, index: fromIndex },
        to: { parentId: to, index: toIndex },
      },
    ]
  }
  // remove subtree
  if (kind < 0.93 && nodeIds.length > 3) {
    return removeSubtreeOps(scene, pick(nodeIds))
  }
  // page ops
  if (kind < 0.96) {
    const page = { ...createPage(`Page ${pages.length + 1}`), id: `pg${pages.length}-${idCounter}` }
    return [{ kind: 'page-add', index: Math.floor(rand() * (pages.length + 1)), page }]
  }
  if (kind < 0.98) {
    const emptyPages = pages.filter((p) => p.rootIds.length === 0 && pages.length > 1)
    if (emptyPages.length > 0) {
      const page = pick(emptyPages)
      return [{ kind: 'page-remove', index: pages.indexOf(page), page: structuredClone(page) }]
    }
  }
  const page = pick(pages)
  return [
    { kind: 'page-rename', pageId: page.id, before: page.name, after: `P${Math.floor(rand() * 99)}` },
  ]
}

// ---------------------------------------------------------------------------
// Hit-test / constraints / serialization parity (Sprint C surfaces)
// ---------------------------------------------------------------------------

function buildRandomScene(entries: number): SceneGraph {
  const scene = new SceneGraph(structuredClone(initialDocument()))
  for (let e = 0; e < entries; e++) {
    applyOps(scene, JSON.parse(JSON.stringify(randomOps(scene))) as PatchOp[])
  }
  return scene
}

describe('hit-test parity (TS <-> WASM)', () => {
  it('hitTestAll / nodesInRect / findDropFrame agree on random scenes', () => {
    for (let round = 0; round < 3; round++) {
      const scene = buildRandomScene(50)
      const handle = new (wasmHandle().SceneHandle)(JSON.stringify(scene.doc))
      const index = new SpatialIndex()
      const opts: HitOptions = { tolerancePx: 6, zoom: pick([0.5, 1, 2]), includeLocked: false }
      const box = scene.documentAABB()
      if (box.minX > box.maxX) {
        handle.free()
        continue
      }
      const px = (t: number) => box.minX - 50 + t * (box.maxX - box.minX + 100)
      const py = (t: number) => box.minY - 50 + t * (box.maxY - box.minY + 100)

      for (let s = 0; s < 120; s++) {
        const p = { x: px(rand()), y: py(rand()) }
        const ts = hitTestAll(scene, index, p, opts)
        const wasm = JSON.parse(
          handle.hitTestAll(p.x, p.y, opts.tolerancePx, opts.zoom, false, ''),
        ) as string[]
        expect(wasm, `round ${round} hit @(${p.x},${p.y})`).toEqual(ts)
      }

      for (let s = 0; s < 30; s++) {
        const x0 = px(rand())
        const y0 = py(rand())
        const rect = { minX: x0, minY: y0, maxX: x0 + rand() * 400, maxY: y0 + rand() * 400 }
        const ts = nodesInRect(scene, index, rect, opts)
        const wasm = JSON.parse(
          handle.nodesInRect(rect.minX, rect.minY, rect.maxX, rect.maxY, opts.tolerancePx, opts.zoom, false, ''),
        ) as string[]
        expect(new Set(wasm), `round ${round} marquee #${s}`).toEqual(new Set(ts))
      }

      for (let s = 0; s < 40; s++) {
        const p = { x: px(rand()), y: py(rand()) }
        const ts = findDropFrame(scene, index, p) ?? null
        const wasm = handle.findDropFrame(p.x, p.y, '') ?? null
        expect(wasm, `round ${round} dropFrame @(${p.x},${p.y})`).toEqual(ts)
      }
      handle.free()
    }
  })
})

describe('constraints parity (TS <-> WASM)', () => {
  it('constrainChild is exact across the constraint matrix', () => {
    const kinds = ['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE'] as const
    for (let i = 0; i < 500; i++) {
      const node = fixedNode(pick(['RECTANGLE', 'LINE', 'FRAME']), 'c', `c${i}`)
      node.constraintsH = pick([...kinds])
      node.constraintsV = pick([...kinds])
      const snap: ChildRect = {
        x: range(-200, 200),
        y: range(-200, 200),
        width: range(0.1, 300),
        height: range(0.1, 300),
      }
      const [oldW, oldH] = [range(0.001, 500), range(0.001, 500)]
      const [newW, newH] = [range(0.001, 800), range(0.001, 800)]
      const tsChild = JSON.parse(JSON.stringify(node)) as SceneNode
      constrainChild(tsChild, snap, oldW, oldH, newW, newH)
      const wasmChild = JSON.parse(
        wasmHandle().constrainChildJson(
          JSON.stringify(node),
          snap.x,
          snap.y,
          snap.width,
          snap.height,
          oldW,
          oldH,
          newW,
          newH,
        ),
      )
      expect(wasmChild, `case ${i}`).toEqual(JSON.parse(JSON.stringify(tsChild)))
    }
  })
})

describe('serialization parity (TS <-> WASM)', () => {
  it('encodeScene produces byte-identical PFRM output; decoders interop', () => {
    const SAVED_AT = '2026-08-01T12:00:00.000Z'
    for (let round = 0; round < 3; round++) {
      const scene = buildRandomScene(40)
      // JSON-normalize so both encoders see identical values (live docs
      // never carry undefined after a journal replay anyway).
      const doc = JSON.parse(JSON.stringify(scene.doc))
      const tsBytes = encodeScene(doc, SAVED_AT)
      const wasmBytes = wasmHandle().encodeSceneBytes(JSON.stringify(doc), SAVED_AT)
      expect(wasmBytes.length, `round ${round} byte length`).toBe(tsBytes.length)
      for (let i = 0; i < tsBytes.length; i++) {
        if (tsBytes[i] !== wasmBytes[i]) {
          throw new Error(`round ${round}: byte ${i} differs (ts ${tsBytes[i]} vs wasm ${wasmBytes[i]})`)
        }
      }
      // Cross-decode: both decoders (each running its own migration pass)
      // must produce the same document from the same bytes. Migration may
      // legitimately add normalizing fields (e.g. libraries: []) that the
      // raw in-memory doc lacked, so the reference is the TS decode.
      const migrated = JSON.parse(JSON.stringify(decodeScene(tsBytes)))
      expect(JSON.parse(JSON.stringify(decodeScene(wasmBytes)))).toEqual(migrated)
      expect(JSON.parse(wasmHandle().decodeSceneJson(tsBytes))).toEqual(migrated)
    }
  })

  it('v1 migration is semantically identical (generated page id masked)', () => {
    const v1 = {
      schemaVersion: 1,
      nodes: { a: { id: 'a', type: 'RECTANGLE' } },
      rootIds: ['a', 'b'],
    }
    const ts = JSON.parse(JSON.stringify(decodeScene(encodeScene(v1 as never, '2026-01-01T00:00:00.000Z'))))
    const wasm = JSON.parse(wasmHandle().migrateDocumentJson(JSON.stringify(v1)))
    const mask = (d: { pages: { id: string }[]; activePageId: string }) => {
      const id = d.pages[0].id
      d.pages[0].id = 'MASKED'
      if (d.activePageId === id) d.activePageId = 'MASKED'
      return d
    }
    expect(mask(wasm)).toEqual(mask(ts))
  })
})

// ---------------------------------------------------------------------------
// Derived passes: instance sync + auto-layout + normalize + GC
// ---------------------------------------------------------------------------
//
// Text auto-resize is excluded by construction (no TEXT nodes here): that
// pass stays host-side until the HarfBuzz stack lands, so the contract under
// test is the sync/layout/normalize/GC fixpoint. Materialized ids come from
// identical injected factories on both sides.

function buildComponentScene(): SceneGraph {
  const scene = new SceneGraph(structuredClone(initialDocument()))
  const ops: PatchOp[] = []
  const comps: string[] = []

  const compCount = 1 + Math.floor(rand() * 2)
  for (let c = 0; c < compCount; c++) {
    const comp = fixedNode('COMPONENT', `Comp ${c}`, `comp${c}-${idCounter}`)
    comp.x = range(-400, 0)
    comp.y = range(-400, 0)
    comp.width = range(100, 300)
    comp.height = range(100, 300)
    ops.push({ kind: 'add', parentId: 'p1', index: 0, node: comp })
    comps.push(comp.id)
    const kids = 1 + Math.floor(rand() * 3)
    for (let k = 0; k < kids; k++) {
      const child = fixedNode(pick(['RECTANGLE', 'ELLIPSE', 'FRAME']), `K${k}`, `${comp.id}-k${k}`)
      child.x = range(0, 100)
      child.y = range(0, 100)
      child.width = range(20, 150)
      child.height = range(20, 150)
      child.constraintsH = pick(['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE'])
      child.constraintsV = pick(['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE'])
      ops.push({ kind: 'add', parentId: comp.id, index: k, node: child })
    }
  }

  // Instances (sometimes resized, sometimes with overrides).
  const instCount = 1 + Math.floor(rand() * 3)
  for (let i = 0; i < instCount; i++) {
    const compId = pick(comps)
    const inst = fixedNode('INSTANCE', `Inst ${i}`, `inst${i}-${idCounter}`)
    if (inst.type !== 'INSTANCE') throw new Error('unreachable')
    inst.componentId = compId
    inst.x = range(0, 600)
    inst.y = range(0, 600)
    inst.width = range(80, 400)
    inst.height = range(80, 400)
    if (rand() < 0.5) {
      inst.overrides = {
        [`${compId}-k0`]: { opacity: Math.round(range(20, 90)) / 100, name: 'Overridden' },
        ...(rand() < 0.4 ? { [compId]: { strokeWeight: Math.round(range(1, 8)) } } : {}),
      }
    }
    ops.push({ kind: 'add', parentId: 'p1', index: 1 + i, node: inst })
  }

  // An auto-layout frame with children, plus a group needing normalization.
  const frame = fixedNode('FRAME', 'AutoFrame', `alf-${idCounter}`)
  if (!('layout' in frame)) throw new Error('unreachable')
  frame.x = 700
  frame.y = 0
  frame.width = 200
  frame.height = 200
  frame.layout = {
    mode: pick(['HORIZONTAL', 'VERTICAL']),
    gap: Math.round(range(0, 24)),
    paddingTop: Math.round(range(0, 20)),
    paddingRight: Math.round(range(0, 20)),
    paddingBottom: Math.round(range(0, 20)),
    paddingLeft: Math.round(range(0, 20)),
    counterAlign: pick(['MIN', 'CENTER', 'MAX']),
    primarySizing: pick(['FIXED', 'HUG']),
    counterSizing: pick(['FIXED', 'HUG']),
  }
  ops.push({ kind: 'add', parentId: 'p1', index: 0, node: frame })
  for (let k = 0; k < 3; k++) {
    const child = fixedNode('RECTANGLE', `F${k}`, `${frame.id}-c${k}`)
    child.width = range(20, 120)
    child.height = range(20, 120)
    ops.push({ kind: 'add', parentId: frame.id, index: k, node: child })
  }

  const group = fixedNode('GROUP', 'G', `grp-${idCounter}`)
  group.x = 0
  group.y = 700
  group.width = 10
  group.height = 10
  ops.push({ kind: 'add', parentId: 'p1', index: 0, node: group })
  for (let k = 0; k < 2; k++) {
    const child = fixedNode('ELLIPSE', `G${k}`, `${group.id}-c${k}`)
    child.x = range(-60, 200)
    child.y = range(-60, 200)
    child.width = range(20, 120)
    child.height = range(20, 120)
    ops.push({ kind: 'add', parentId: group.id, index: k, node: child })
  }

  idCounter++
  applyOps(scene, JSON.parse(JSON.stringify(ops)) as PatchOp[])
  return scene
}

describe('derived passes parity (TS <-> WASM)', () => {
  it('sync/layout/normalize/GC reach identical fixpoints with identical minted ids', () => {
    for (let round = 0; round < 6; round++) {
      const scene = buildComponentScene()
      const handle = new (wasmHandle().SceneHandle)(JSON.stringify(scene.doc))

      let minted = 0
      setMaterializeIdFactory(() => `m${++minted}`)
      try {
        runDerivedPasses(scene)
        handle.runDerivedPasses('m')
        expectDocsEqual(handle, scene, `derived round ${round}`)
        expectGeometryEqual(handle, scene, `derived round ${round}`)

        // A second run must be a no-op on both sides (fixpoint reached).
        const before = JSON.stringify(scene.doc)
        runDerivedPasses(scene)
        handle.runDerivedPasses('m')
        expect(JSON.stringify(scene.doc), `round ${round} TS fixpoint`).toBe(before)
        expectDocsEqual(handle, scene, `derived round ${round} (2nd run)`)

        // Component edit -> instances resync identically.
        const comp = Object.values(scene.doc.nodes).find((n) => n.type === 'COMPONENT')
        if (comp && comp.type === 'COMPONENT' && comp.children.length > 0) {
          const ops: PatchOp[] = [
            makeUpdateOp(scene.getNode(comp.children[0])!, { width: Math.round(range(30, 200)) }),
          ]
          const json = JSON.parse(JSON.stringify(ops)) as PatchOp[]
          applyOps(scene, json)
          handle.applyOps(JSON.stringify(json))
          runDerivedPasses(scene)
          handle.runDerivedPasses('m')
          expectDocsEqual(handle, scene, `derived round ${round} (after component edit)`)
        }
      } finally {
        setMaterializeIdFactory(null)
      }
      handle.free()
    }
  })
})

describe('randomized op fuzz (TS <-> WASM scene engines)', () => {
  it('documents and geometry stay identical through random op sequences', () => {
    const ROUNDS = 3
    const ENTRIES = 60
    for (let round = 0; round < ROUNDS; round++) {
      const initial = initialDocument()
      const scene = new SceneGraph(structuredClone(initial))
      const handle = new (wasmHandle().SceneHandle)(JSON.stringify(initial))
      const applied: PatchOp[][] = []

      for (let e = 0; e < ENTRIES; e++) {
        const ops = JSON.parse(JSON.stringify(randomOps(scene))) as PatchOp[]
        applyOps(scene, ops)
        handle.applyOps(JSON.stringify(ops))
        applied.push(ops)
        if (e % 10 === 9) expectDocsEqual(handle, scene, `round ${round} entry ${e}`)
      }
      expectDocsEqual(handle, scene, `round ${round} final`)
      expectGeometryEqual(handle, scene, `round ${round} final`)

      for (let i = applied.length - 1; i >= 0; i--) {
        undoOps(scene, applied[i])
        handle.undoOps(JSON.stringify(applied[i]))
      }
      expectDocsEqual(handle, scene, `round ${round} after undo-all`)
      expect(JSON.parse(handle.docJson()), `round ${round} undo vs initial`).toEqual(
        JSON.parse(JSON.stringify(initial)),
      )
      handle.free()
    }
  })
})
