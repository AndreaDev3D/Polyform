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
  ])
  const node = fixedNode(type, `Node ${idCounter + 1}`, nextId())
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
