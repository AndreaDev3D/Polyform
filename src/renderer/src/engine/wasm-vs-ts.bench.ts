// Sprint A perf gate (docs/V0.4-Porting-Plan.md): each ported module needs
// >= 2x TS on its micro-bench or a written justification. Run with
// `npm run bench`; results are recorded in the porting plan.

import { bench, describe } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import RBush from 'rbush'

import { initWasmEngine, setEngineBackend, wasmHandle } from './backend'
import { encodeSubPaths, decodeRings, decodeSubPaths } from './wasm/codec'
import { flattenSubPath, roundedRectPath, subPathsToSvg } from './shapes'
import { matMultiply, type Mat } from './geometry'
import { SceneGraph } from './scene'
import { booleanRings, clearBooleanCache } from './booleans'
import { createNode, type BooleanNode } from './types'

const wasmPath = fileURLToPath(new URL('./wasm/pkg/polyform_core_bg.wasm', import.meta.url))
await initWasmEngine(readFileSync(wasmPath))
const w = wasmHandle()

// ---------------------------------------------------------------------------
// spatial index: 10k boxes, bulk load + point/box queries
// ---------------------------------------------------------------------------

interface E {
  minX: number
  minY: number
  maxX: number
  maxY: number
  idx: number
}

const COUNT = 10_000
const entries: E[] = []
const boxes = new Float64Array(COUNT * 4)
let seed = 42
const rnd = () => {
  // xorshift — deterministic workload
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) / 4294967296
}
for (let i = 0; i < COUNT; i++) {
  const x = rnd() * 20000
  const y = rnd() * 20000
  const wd = 10 + rnd() * 400
  const ht = 10 + rnd() * 400
  entries.push({ minX: x, minY: y, maxX: x + wd, maxY: y + ht, idx: i })
  boxes.set([x, y, x + wd, y + ht], i * 4)
}
const loadedRbush = new RBush<E>()
loadedRbush.load(entries)
const loadedWasm = new w.SpatialIndex()
loadedWasm.load(boxes)

describe('spatial: bulk load 10k', () => {
  bench('rbush (TS)', () => {
    const t = new RBush<E>()
    t.load(entries)
  })
  bench('rstar (WASM)', () => {
    const t = new w.SpatialIndex()
    t.load(boxes)
    t.free()
  })
})

describe('spatial: 200 box queries over 10k', () => {
  bench('rbush (TS)', () => {
    let acc = 0
    for (let q = 0; q < 200; q++) {
      const x = (q * 97) % 20000
      const y = (q * 131) % 20000
      acc += loadedRbush.search({ minX: x, minY: y, maxX: x + 800, maxY: y + 800 }).length
    }
    if (acc < 0) throw new Error('unreachable')
  })
  bench('rstar (WASM)', () => {
    let acc = 0
    for (let q = 0; q < 200; q++) {
      const x = (q * 97) % 20000
      const y = (q * 131) % 20000
      acc += loadedWasm.search(x, y, x + 800, y + 800).length
    }
    if (acc < 0) throw new Error('unreachable')
  })
})

// ---------------------------------------------------------------------------
// shapes: per-call boundary cost vs pure TS
// ---------------------------------------------------------------------------

const radius = { tl: 12, tr: 12, br: 12, bl: 12 }
const oneSubPath = roundedRectPath(200, 120, radius)
const manyPaths = Array.from({ length: 50 }, (_, i) =>
  roundedRectPath(100 + i, 80 + i, { tl: i % 20, tr: 4, br: 16, bl: 0 }),
)

describe('shapes: flatten one rounded-rect subpath', () => {
  bench('TS flattenSubPath', () => {
    flattenSubPath(oneSubPath, 0.25)
  })
  bench('WASM (encode + flattenSubPaths + decode)', () => {
    decodeRings(w.flattenSubPaths(encodeSubPaths([oneSubPath]), 0.25))
  })
})

describe('shapes: outline one rounded rect', () => {
  bench('TS roundedRectPath', () => {
    roundedRectPath(200, 120, radius)
  })
  bench('WASM roundedRectPath + decode', () => {
    decodeSubPaths(w.roundedRectPath(200, 120, 12, 12, 12, 12))
  })
})

describe('shapes: SVG path data for 50 subpaths', () => {
  const encoded = encodeSubPaths(manyPaths)
  bench('TS subPathsToSvg', () => {
    subPathsToSvg(manyPaths)
  })
  bench('WASM subPathsToSvg (pre-encoded)', () => {
    w.subPathsToSvg(encoded, 3)
  })
  bench('WASM subPathsToSvg (incl. encode)', () => {
    w.subPathsToSvg(encodeSubPaths(manyPaths), 3)
  })
})

// ---------------------------------------------------------------------------
// booleans: polygon-clipping (TS) vs exact CSG (WASM)
// ---------------------------------------------------------------------------

const boolScene = new SceneGraph()
const boolNode = createNode('BOOLEAN', 'B') as BooleanNode
boolNode.booleanOp = 'UNION'
boolScene.addNode(boolNode, null, 0)
for (let i = 0; i < 4; i++) {
  const kind = i % 2 === 0 ? 'ELLIPSE' : 'RECTANGLE'
  const n = createNode(kind, `c${i}`)
  n.x = i * 60
  n.y = (i % 2) * 40
  n.width = 120
  n.height = 100
  if (n.type === 'RECTANGLE') n.cornerRadius = { tl: 16, tr: 16, br: 16, bl: 16 }
  boolScene.addNode(n, boolNode.id, i)
}

describe('booleans: union of 4 overlapping shapes', () => {
  bench('TS polygon-clipping (flattened)', () => {
    setEngineBackend('booleans', 'ts')
    clearBooleanCache()
    booleanRings(boolScene, boolNode)
  })
  bench('WASM exact CSG (flo_curves)', () => {
    setEngineBackend('booleans', 'wasm')
    clearBooleanCache()
    booleanRings(boolScene, boolNode)
  })
})

// ---------------------------------------------------------------------------
// geometry: why fine-grained math keeps no runtime flag
// ---------------------------------------------------------------------------

const m1: Mat = { a: 1.2, b: 0.1, c: -0.4, d: 0.9, e: 100, f: -50 }
const m2: Mat = { a: 0.7, b: -0.2, c: 0.3, d: 1.1, e: -20, f: 35 }
const m1a = new Float64Array([m1.a, m1.b, m1.c, m1.d, m1.e, m1.f])
const m2a = new Float64Array([m2.a, m2.b, m2.c, m2.d, m2.e, m2.f])

describe('geometry: 1000 matrix multiplies', () => {
  bench('TS matMultiply', () => {
    let m = m1
    for (let i = 0; i < 1000; i++) m = matMultiply(m, m2)
    if (Number.isNaN(m.a)) throw new Error('unreachable')
  })
  bench('WASM matMultiply (per-call boundary)', () => {
    let m: Float64Array = m1a
    for (let i = 0; i < 1000; i++) m = w.matMultiply(m, m2a)
    if (Number.isNaN(m[0])) throw new Error('unreachable')
  })
})
