// Differential tests: TypeScript engine vs the Rust/WASM port
// (crates/polyform-core), per the V0.4-Porting-Plan verification gates.
//
// Comparison rules:
// - Pure IEEE 754 arithmetic (+ - * / sqrt, comparisons) is bit-identical
//   between V8 and Rust — compared EXACTLY (Object.is per component).
// - Transcendentals (sin/cos/hypot) may differ in the last ulp between V8's
//   and Rust's libm — compared with relative tolerance 1e-12.
// - SVG strings are compared token-by-token: command letters exactly,
//   numbers numerically (formatting of decimal-exact ties may differ).

import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  applyMat,
  aabbOfPoints,
  distToSegment,
  flattenCubic,
  matInvert,
  matMultiply,
  matRotateDeg,
  nodeLocalMatrix,
  pointInEllipse,
  pointInPolygonRings,
  pointInRoundedRect,
  transformedRectAABB,
  type Mat,
} from './geometry'
import {
  arcPath,
  ellipsePath,
  flattenSubPath,
  linePath,
  networkToSubPaths,
  nodeOutline,
  polygonPath,
  roundedRectPath,
  starPath,
  subPathsToSvg,
  type SubPath,
} from './shapes'
import type { BooleanNode, SceneNode, Vec2, VectorNetwork } from './types'
import { createNode } from './types'
import { SceneGraph } from './scene'
import { booleanRings, clearBooleanCache } from './booleans'
import { getEngineBackends, initWasmEngine, setEngineBackend, wasmHandle } from './backend'
import { decodeRings, decodeSubPaths, encodeNetwork, encodeSubPaths } from './wasm/codec'
import RBush from 'rbush'

const N = Number(process.env.FUZZ_N ?? 1000)

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('./wasm/pkg/polyform_core_bg.wasm', import.meta.url))
  const ok = await initWasmEngine(readFileSync(wasmPath))
  expect(ok).toBe(true)
})

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — identical inputs on every run
// ---------------------------------------------------------------------------

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

const rand = mulberry32(0x504f4c59) // 'POLY'
const range = (lo: number, hi: number) => lo + rand() * (hi - lo)

function randMat(): Mat {
  return {
    a: range(-4, 4),
    b: range(-4, 4),
    c: range(-4, 4),
    d: range(-4, 4),
    e: range(-2000, 2000),
    f: range(-2000, 2000),
  }
}

const matArr = (m: Mat) => new Float64Array([m.a, m.b, m.c, m.d, m.e, m.f])

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

function exactly(actual: number, expected: number, label: string) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label}: WASM ${actual} !== TS ${expected}`)
  }
}

function close(actual: number, expected: number, label: string, tol = 1e-12) {
  if (Object.is(actual, expected)) return
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected))
  if (Math.abs(actual - expected) > tol * scale) {
    throw new Error(`${label}: WASM ${actual} vs TS ${expected} (tol ${tol})`)
  }
}

function exactMat(actual: Float64Array, expected: Mat, label: string) {
  const e = [expected.a, expected.b, expected.c, expected.d, expected.e, expected.f]
  for (let i = 0; i < 6; i++) exactly(actual[i], e[i], `${label}[${i}]`)
}

function closeMat(actual: Float64Array, expected: Mat, label: string) {
  const e = [expected.a, expected.b, expected.c, expected.d, expected.e, expected.f]
  for (let i = 0; i < 6; i++) close(actual[i], e[i], `${label}[${i}]`)
}

function samePaths(
  actual: SubPath[],
  expected: SubPath[],
  label: string,
  cmp: (a: number, b: number, l: string) => void,
) {
  expect(actual.length, `${label}: path count`).toBe(expected.length)
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i]
    const b = expected[i]
    expect(a.closed, `${label}[${i}].closed`).toBe(b.closed)
    expect(a.anchors.length, `${label}[${i}].anchors`).toBe(b.anchors.length)
    for (let k = 0; k < a.anchors.length; k++) {
      const aa = a.anchors[k]
      const bb = b.anchors[k]
      cmp(aa.p.x, bb.p.x, `${label}[${i}].a[${k}].p.x`)
      cmp(aa.p.y, bb.p.y, `${label}[${i}].a[${k}].p.y`)
      expect(aa.cpIn === null, `${label}[${i}].a[${k}].cpIn null`).toBe(bb.cpIn === null)
      expect(aa.cpOut === null, `${label}[${i}].a[${k}].cpOut null`).toBe(bb.cpOut === null)
      if (aa.cpIn && bb.cpIn) {
        cmp(aa.cpIn.x, bb.cpIn.x, `${label}.cpIn.x`)
        cmp(aa.cpIn.y, bb.cpIn.y, `${label}.cpIn.y`)
      }
      if (aa.cpOut && bb.cpOut) {
        cmp(aa.cpOut.x, bb.cpOut.x, `${label}.cpOut.x`)
        cmp(aa.cpOut.y, bb.cpOut.y, `${label}.cpOut.y`)
      }
    }
  }
}

function samePoints(actual: Vec2[], expected: Vec2[], label: string) {
  expect(actual.length, `${label}: length`).toBe(expected.length)
  for (let i = 0; i < actual.length; i++) {
    close(actual[i].x, expected[i].x, `${label}[${i}].x`)
    close(actual[i].y, expected[i].y, `${label}[${i}].y`)
  }
}

function sameSvg(actual: string, expected: string, label: string) {
  const at = actual.split(/\s+/)
  const et = expected.split(/\s+/)
  expect(at.length, `${label}: token count`).toBe(et.length)
  for (let i = 0; i < at.length; i++) {
    if (/^[A-Za-z]$/.test(et[i])) {
      expect(at[i], `${label}[${i}]`).toBe(et[i])
    } else {
      close(Number(at[i]), Number(et[i]), `${label}[${i}]`, 1e-9)
    }
  }
}

// ---------------------------------------------------------------------------
// geometry.ts <-> geometry.rs
// ---------------------------------------------------------------------------

describe('geometry parity (TS <-> WASM)', () => {
  it('matMultiply / matInvert / applyMat are exact', () => {
    const w = wasmHandle()
    for (let i = 0; i < N; i++) {
      const m1 = randMat()
      const m2 = randMat()
      exactMat(w.matMultiply(matArr(m1), matArr(m2)), matMultiply(m1, m2), 'matMultiply')
      exactMat(w.matInvert(matArr(m1)), matInvert(m1), 'matInvert')
      const p = { x: range(-1000, 1000), y: range(-1000, 1000) }
      const tp = applyMat(m1, p)
      const wp = w.applyMat(matArr(m1), p.x, p.y)
      exactly(wp[0], tp.x, 'applyMat.x')
      exactly(wp[1], tp.y, 'applyMat.y')
    }
    // near-singular determinant branch
    const sing: Mat = { a: 2, b: 4, c: 1, d: 2, e: 9, f: 9 }
    exactMat(w.matInvert(matArr(sing)), matInvert(sing), 'matInvert(singular)')
  })

  it('matRotateDeg / nodeLocalMatrix within transcendental tolerance', () => {
    const w = wasmHandle()
    for (let i = 0; i < N; i++) {
      const deg = range(-720, 720)
      closeMat(w.matRotateDeg(deg), matRotateDeg(deg), 'matRotateDeg')
      const [x, y, wd, ht] = [range(-500, 500), range(-500, 500), range(0, 400), range(0, 400)]
      const fh = rand() < 0.5
      const fv = rand() < 0.5
      closeMat(
        w.nodeLocalMatrix(x, y, wd, ht, deg, fh, fv),
        nodeLocalMatrix(x, y, wd, ht, deg, fh, fv),
        'nodeLocalMatrix',
      )
      // rotation === 0 short-circuit is pure arithmetic -> exact. With a flip it
      // is still only arithmetic (a sign and two translates), so it stays exact.
      exactMat(w.nodeLocalMatrix(x, y, wd, ht, 0, false, false), nodeLocalMatrix(x, y, wd, ht, 0), 'nlm(0)')
      exactMat(
        w.nodeLocalMatrix(x, y, wd, ht, 0, fh, fv),
        nodeLocalMatrix(x, y, wd, ht, 0, fh, fv),
        'nlm(0, flipped)',
      )
    }
  })

  it('transformedRectAABB / aabbOfPoints are exact', () => {
    const w = wasmHandle()
    for (let i = 0; i < N; i++) {
      const m = randMat()
      const [wd, ht] = [range(0, 500), range(0, 500)]
      const tb = transformedRectAABB(m, wd, ht)
      const wb = w.transformedRectAabb(matArr(m), wd, ht)
      exactly(wb[0], tb.minX, 'aabb.minX')
      exactly(wb[1], tb.minY, 'aabb.minY')
      exactly(wb[2], tb.maxX, 'aabb.maxX')
      exactly(wb[3], tb.maxY, 'aabb.maxY')

      const pts: Vec2[] = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => ({
        x: range(-1000, 1000),
        y: range(-1000, 1000),
      }))
      const flat = new Float64Array(pts.flatMap((p) => [p.x, p.y]))
      const tsBox = aabbOfPoints(pts)
      const wasmBox = w.aabbOfPoints(flat)
      exactly(wasmBox[0], tsBox.minX, 'pts.minX')
      exactly(wasmBox[1], tsBox.minY, 'pts.minY')
      exactly(wasmBox[2], tsBox.maxX, 'pts.maxX')
      exactly(wasmBox[3], tsBox.maxY, 'pts.maxY')
    }
  })

  it('flattenCubic: identical step counts, coords within tolerance', () => {
    const w = wasmHandle()
    for (let i = 0; i < N; i++) {
      const cubic: Vec2[] = Array.from({ length: 4 }, () => ({
        x: range(-500, 500),
        y: range(-500, 500),
      }))
      const tol = [0.1, 0.25, 0.5, 1][Math.floor(rand() * 4)]
      const ts = flattenCubic(cubic[0], cubic[1], cubic[2], cubic[3], tol)
      const flat = new Float64Array(cubic.flatMap((p) => [p.x, p.y]))
      const wasm = w.flattenCubic(flat, tol)
      expect(wasm.length, 'flattenCubic point count').toBe(ts.length * 2)
      for (let k = 0; k < ts.length; k++) {
        close(wasm[k * 2], ts[k].x, `flattenCubic[${k}].x`)
        close(wasm[k * 2 + 1], ts[k].y, `flattenCubic[${k}].y`)
      }
    }
  })

  it('distToSegment within tolerance; degenerate segment exact-ish', () => {
    const w = wasmHandle()
    for (let i = 0; i < N; i++) {
      const [px, py, ax, ay, bx, by] = Array.from({ length: 6 }, () => range(-300, 300))
      close(
        w.distToSegment(px, py, ax, ay, bx, by),
        distToSegment({ x: px, y: py }, { x: ax, y: ay }, { x: bx, y: by }),
        'distToSegment',
      )
      close(
        w.distToSegment(px, py, ax, ay, ax, ay),
        distToSegment({ x: px, y: py }, { x: ax, y: ay }, { x: ax, y: ay }),
        'distToSegment(point)',
      )
    }
  })

  it('point-in-shape predicates agree exactly', () => {
    const w = wasmHandle()
    for (let i = 0; i < N; i++) {
      // polygon rings
      const rings: Vec2[][] = Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
        Array.from({ length: 3 + Math.floor(rand() * 6) }, () => ({
          x: range(-100, 100),
          y: range(-100, 100),
        })),
      )
      const p = { x: range(-120, 120), y: range(-120, 120) }
      const ringData = new Float64Array(rings.flatMap((r) => r.flatMap((q) => [q.x, q.y])))
      const ringLens = new Uint32Array(rings.map((r) => r.length))
      const evenOdd = rand() < 0.5
      expect(
        w.pointInPolygonRings(p.x, p.y, ringData, ringLens, evenOdd),
        `pointInPolygonRings #${i}`,
      ).toBe(pointInPolygonRings(p, rings, evenOdd))

      // ellipse
      const [cx, cy, rx, ry] = [range(-50, 50), range(-50, 50), range(-10, 100), range(-10, 100)]
      expect(w.pointInEllipse(p.x, p.y, cx, cy, rx, ry), `pointInEllipse #${i}`).toBe(
        pointInEllipse(p, cx, cy, rx, ry),
      )

      // rounded rect
      const [rw, rh] = [range(1, 200), range(1, 200)]
      const rr = { tl: range(-5, 80), tr: range(-5, 80), br: range(-5, 80), bl: range(-5, 80) }
      const q = { x: range(-10, 210), y: range(-10, 210) }
      expect(
        w.pointInRoundedRect(q.x, q.y, rw, rh, rr.tl, rr.tr, rr.br, rr.bl),
        `pointInRoundedRect #${i}`,
      ).toBe(pointInRoundedRect(q, rw, rh, rr))
    }
  })
})

// ---------------------------------------------------------------------------
// shapes.ts <-> shapes.rs
// ---------------------------------------------------------------------------

function randomNetwork(): VectorNetwork {
  const nVerts = 2 + Math.floor(rand() * 10)
  const vertices = Array.from({ length: nVerts }, (_, i) => ({
    id: i,
    x: range(-200, 200),
    y: range(-200, 200),
    // A third of the points ask to be rounded, over a range that runs from
    // "barely visible" to "far more than the neighbouring segment can give",
    // so the clamp and the degenerate branches both get exercised.
    ...(rand() < 0.34 ? { cornerRadius: range(0, 300) } : {}),
  }))
  const nEdges = 1 + Math.floor(rand() * 14)
  const edges = Array.from({ length: nEdges }, (_, i) => {
    const v0 = Math.floor(rand() * nVerts)
    const v1 = Math.floor(rand() * nVerts)
    const withCp0 = rand() < 0.3
    const withCp1 = rand() < 0.3
    return {
      id: i,
      v0,
      v1,
      cp0: withCp0 ? { x: range(-200, 200), y: range(-200, 200) } : null,
      cp1: withCp1 ? { x: range(-200, 200), y: range(-200, 200) } : null,
    }
  })
  return { vertices, edges }
}

describe('shapes parity (TS <-> WASM)', () => {
  it('primitive outlines are exact (rect/ellipse/line)', () => {
    const w = wasmHandle()
    for (let i = 0; i < N; i++) {
      const [wd, ht] = [range(0, 400), range(0, 400)]
      const r = { tl: range(-10, 250), tr: range(-10, 250), br: range(-10, 250), bl: range(-10, 250) }
      samePaths(
        decodeSubPaths(w.roundedRectPath(wd, ht, r.tl, r.tr, r.br, r.bl)),
        [roundedRectPath(wd, ht, r)],
        'roundedRectPath',
        exactly,
      )
      samePaths(decodeSubPaths(w.ellipsePath(wd, ht)), [ellipsePath(wd, ht)], 'ellipsePath', exactly)
      samePaths(decodeSubPaths(w.linePath(wd)), [linePath(wd)], 'linePath', exactly)
    }
  })

  it('polygon/star outlines within transcendental tolerance', () => {
    const w = wasmHandle()
    for (let i = 0; i < N; i++) {
      const [wd, ht] = [range(0, 400), range(0, 400)]
      const points = rand() < 0.8 ? 3 + Math.floor(rand() * 10) : range(2.2, 12.7)
      const inner = range(-0.2, 1.4)
      samePaths(
        decodeSubPaths(w.polygonPath(wd, ht, points)),
        [polygonPath(wd, ht, points)],
        'polygonPath',
        close,
      )
      samePaths(
        decodeSubPaths(w.starPath(wd, ht, points, inner)),
        [starPath(wd, ht, points, inner)],
        'starPath',
        close,
      )
    }
  })

  it('arc/pie/ring outlines within transcendental tolerance', () => {
    const w = wasmHandle()
    for (let i = 0; i < N; i++) {
      const [wd, ht] = [range(0, 400), range(0, 400)]
      // Deliberately include out-of-range inputs — both sides must clamp
      // identically, not just agree on the happy path.
      const start = range(-1.5, 1.5)
      const sweep = range(-1.4, 1.4)
      const ratio = range(-0.3, 1.3)
      samePaths(
        decodeSubPaths(w.arcPath(wd, ht, start, sweep, ratio)),
        [arcPath(wd, ht, start, sweep, ratio)],
        'arcPath',
        close,
      )
    }
  })

  it('vector network chain walking is exact', () => {
    const w = wasmHandle()
    for (let i = 0; i < N; i++) {
      const network = randomNetwork()
      const { vertices, edges } = encodeNetwork(network)
      samePaths(
        decodeSubPaths(w.networkToSubPaths(vertices, edges)),
        networkToSubPaths(network),
        `network #${i}`,
        exactly,
      )
    }
  })

  it('flattenSubPaths matches flattenSubPath per ring', () => {
    const w = wasmHandle()
    for (let i = 0; i < N; i++) {
      const sp =
        rand() < 0.5
          ? roundedRectPath(range(1, 300), range(1, 300), {
              tl: range(0, 60),
              tr: range(0, 60),
              br: range(0, 60),
              bl: range(0, 60),
            })
          : ellipsePath(range(1, 300), range(1, 300))
      const tol = [0.25, 0.5, 1][Math.floor(rand() * 3)]
      const rings = decodeRings(w.flattenSubPaths(encodeSubPaths([sp]), tol))
      expect(rings.length).toBe(1)
      samePoints(rings[0], flattenSubPath(sp, tol), `flatten #${i}`)
    }
  })

  it('subPathsToSvg emits token-equivalent path data', () => {
    const w = wasmHandle()
    for (let i = 0; i < N / 4; i++) {
      const paths: SubPath[] = [
        roundedRectPath(range(1, 300), range(1, 300), {
          tl: range(0, 60),
          tr: 0,
          br: range(0, 60),
          bl: 0,
        }),
        ellipsePath(range(1, 300), range(1, 300)),
        linePath(range(1, 300)),
        networkToSubPaths(randomNetwork()),
      ].flat()
      sameSvg(w.subPathsToSvg(encodeSubPaths(paths), 3), subPathsToSvg(paths), `svg #${i}`)
    }
  })
})

// ---------------------------------------------------------------------------
// spatial-index <-> spatial.rs (rbush vs rstar, set semantics)
// ---------------------------------------------------------------------------

describe('spatial index parity (rbush <-> rstar)', () => {
  it('search returns identical result sets, including edge touches', () => {
    const w = wasmHandle()
    interface E {
      minX: number
      minY: number
      maxX: number
      maxY: number
      idx: number
    }
    const count = 800
    const entries: E[] = []
    const boxes = new Float64Array(count * 4)
    for (let i = 0; i < count; i++) {
      // grid-aligned boxes so edge-touching queries are common
      const x = Math.floor(rand() * 40) * 25
      const y = Math.floor(rand() * 40) * 25
      const wd = (1 + Math.floor(rand() * 8)) * 25
      const ht = (1 + Math.floor(rand() * 8)) * 25
      entries.push({ minX: x, minY: y, maxX: x + wd, maxY: y + ht, idx: i })
      boxes.set([x, y, x + wd, y + ht], i * 4)
    }
    const rbush = new RBush<E>()
    rbush.load(entries)
    const tree = new w.SpatialIndex()
    tree.load(boxes)

    for (let q = 0; q < N; q++) {
      const qx = Math.floor(rand() * 44 - 2) * 25
      const qy = Math.floor(rand() * 44 - 2) * 25
      const qw = Math.floor(rand() * 10) * 25
      const qh = Math.floor(rand() * 10) * 25
      const tsSet = new Set(rbush.search({ minX: qx, minY: qy, maxX: qx + qw, maxY: qy + qh }).map((e) => e.idx))
      const wasmHits = tree.search(qx, qy, qx + qw, qy + qh)
      expect(wasmHits.length, `query #${q} size`).toBe(tsSet.size)
      for (const h of wasmHits) expect(tsSet.has(h), `query #${q} id ${h}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// booleans: TS polygon-clipping vs WASM exact CSG (flo_curves)
// ---------------------------------------------------------------------------
//
// The outputs are intentionally NOT identical (that's the point — exact
// curves instead of 0.5-tolerance facets), so the gate is semantic: sampled
// even-odd membership over the result must agree away from the flattening
// band, and the WASM engine must survive every case (no traps/poisoning).

function randShapeNode(scene: SceneGraph, parent: string, index: number): void {
  const kind = ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR'][Math.floor(rand() * 4)]
  const node = createNode(kind as SceneNode['type'], `s${index}`)
  node.x = range(-50, 150)
  node.y = range(-50, 150)
  node.width = range(30, 220)
  node.height = range(30, 220)
  if (rand() < 0.3) node.rotation = range(-90, 90)
  if (node.type === 'RECTANGLE' && rand() < 0.5) {
    const r = range(0, 40)
    node.cornerRadius = { tl: r, tr: r, br: r, bl: r }
  }
  scene.addNode(node, parent, index)
}

describe('boolean CSG parity (WASM vs ground truth, semantic)', () => {
  // The gate compares the WASM CSG against INDEPENDENT ground truth: each
  // sample point is classified per child (fine-flattened outlines), then the
  // op semantics decide membership. Comparing against the TS backend instead
  // would be misleading — polygon-clipping's throw-fallback returns the
  // first child whole on degenerate input, i.e. the TS result is sometimes
  // legitimately wrong where the exact CSG is right.
  it('WASM result matches op semantics on random scenes; engine never traps', () => {
    const CASES = Math.max(60, Math.floor(N / 8))
    for (let c = 0; c < CASES; c++) {
      const scene = new SceneGraph()
      const bool = createNode('BOOLEAN', 'Bool') as BooleanNode
      const op = (['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE'] as const)[Math.floor(rand() * 4)]
      bool.booleanOp = op
      scene.addNode(bool, null, 0)
      const childCount = 2 + Math.floor(rand() * 2)
      for (let i = 0; i < childCount; i++) randShapeNode(scene, bool.id, i)

      // Ground truth: per-child fine-flattened rings in bool-local space.
      const childRings: Vec2[][][] = bool.children.map((cid) => {
        const child = scene.getNode(cid)!
        const m = scene.localMatrix(child)
        return nodeOutline(child)
          .filter((sp) => sp.closed)
          .map((sp) => flattenSubPath(sp, 0.05).map((p) => applyMat(m, p)))
          .filter((r) => r.length >= 3)
      })
      const truth = (p: Vec2): boolean => {
        const inside = childRings.map((rings) => pointInPolygonRings(p, rings, false))
        switch (op) {
          case 'UNION':
            return inside.some(Boolean)
          case 'SUBTRACT':
            return inside[0] && !inside.slice(1).some(Boolean)
          case 'INTERSECT':
            return inside.every(Boolean)
          case 'EXCLUDE':
            return inside.filter(Boolean).length % 2 === 1
        }
      }

      setEngineBackend('booleans', 'wasm')
      clearBooleanCache()
      const wasmRings = booleanRings(scene, bool)
      expect(getEngineBackends().wasmLoaded, `case ${c}: engine poisoned`).toBe(true)

      const allPts = childRings.flat(2)
      if (allPts.length === 0) continue
      const box = aabbOfPoints(allPts)
      const SAMPLES = 400
      let agree = 0
      let counted = 0
      for (let s = 0; s < SAMPLES; s++) {
        const p = {
          x: box.minX + rand() * Math.max(1e-9, box.maxX - box.minX),
          y: box.minY + rand() * Math.max(1e-9, box.maxY - box.minY),
        }
        // Skip the flattening band around any child edge — classification
        // there is tolerance noise in every implementation.
        if (childRings.some((rings) => nearAnyEdge(p, rings, 1.0))) continue
        counted++
        if (pointInPolygonRings(p, wasmRings, true) === truth(p)) agree++
      }
      if (counted === 0) continue
      const ratio = agree / counted
      if (ratio < 0.99) {
        console.log(
          `CASE ${c} op=${op} children=` +
            JSON.stringify(
              bool.children.map((cid) => {
                const n = scene.getNode(cid)! as SceneNode & {
                  cornerRadius?: unknown
                  pointCount?: number
                  innerRatio?: number
                }
                return {
                  type: n.type,
                  x: n.x,
                  y: n.y,
                  w: n.width,
                  h: n.height,
                  rot: n.rotation,
                  r: n.cornerRadius,
                  pc: n.pointCount,
                  ir: n.innerRatio,
                }
              }),
            ) +
            ` wasmRings=${wasmRings.length}`,
        )
      }
      expect(
        ratio,
        `case ${c} (${op}, ${childCount} children): WASM vs truth agreement ${ratio}`,
      ).toBeGreaterThanOrEqual(0.99)
    }
    setEngineBackend('booleans', 'wasm')
  })

  it('touching and coincident edges do not trap the engine', () => {
    for (const op of ['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE'] as const) {
      const scene = new SceneGraph()
      const bool = createNode('BOOLEAN', 'Bool') as BooleanNode
      bool.booleanOp = op
      scene.addNode(bool, null, 0)
      // exactly edge-sharing rects, then an exactly coincident pair
      const a = createNode('RECTANGLE', 'A')
      a.x = 0
      a.y = 0
      a.width = 100
      a.height = 100
      scene.addNode(a, bool.id, 0)
      const b = createNode('RECTANGLE', 'B')
      b.x = 100
      b.y = 0
      b.width = 100
      b.height = 100
      scene.addNode(b, bool.id, 1)
      const cNode = createNode('RECTANGLE', 'C')
      cNode.x = 0
      cNode.y = 0
      cNode.width = 100
      cNode.height = 100
      scene.addNode(cNode, bool.id, 2)

      setEngineBackend('booleans', 'wasm')
      clearBooleanCache()
      const rings = booleanRings(scene, bool)
      expect(getEngineBackends().wasmLoaded, `${op}: engine poisoned`).toBe(true)
      expect(Array.isArray(rings)).toBe(true)
    }
  })
})

function nearAnyEdge(p: Vec2, rings: Vec2[][], dist: number): boolean {
  for (const ring of rings) {
    const n = ring.length
    for (let i = 0; i < n; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % n]
      if (distToSegment(p, a, b) <= dist) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Backend switch: run representative shape behavior with shapes='wasm'
// ---------------------------------------------------------------------------

describe('shapes module behind the wasm flag', () => {
  it('nodeOutline/flattenSubPath/subPathsToSvg route through WASM and agree', () => {
    const rect = createNode('RECTANGLE', 'r')
    if (rect.type !== 'RECTANGLE') throw new Error('unreachable')
    rect.width = 120
    rect.height = 80
    rect.cornerRadius = { tl: 10, tr: 0, br: 24, bl: 4 }
    const star = createNode('STAR', 's')
    star.width = 90
    star.height = 90
    // An arced ellipse: nodeOutline has to route to arc_path, not ellipse_path
    // (it did not, so every arc drew as a whole ellipse under this backend).
    const donut = createNode('ELLIPSE', 'd')
    if (donut.type !== 'ELLIPSE') throw new Error('unreachable')
    donut.width = 140
    donut.height = 100
    donut.arcStart = -0.125
    donut.arcSweep = 0.7
    donut.arcRatio = 0.4
    const full = createNode('ELLIPSE', 'f')
    full.width = 60
    full.height = 60
    const nodes: SceneNode[] = [rect, star, donut, full]

    setEngineBackend('shapes', 'ts')
    const tsOutlines = nodes.map((n) => nodeOutline(n))
    const tsSvg = tsOutlines.map((o) => subPathsToSvg(o))
    const tsFlat = tsOutlines.map((o) => o.map((sp) => flattenSubPath(sp)))

    setEngineBackend('shapes', 'wasm')
    expect(getEngineBackends().shapes).toBe('wasm')
    try {
      const wasmOutlines = nodes.map((n) => nodeOutline(n))
      const wasmSvg = wasmOutlines.map((o) => subPathsToSvg(o))
      const wasmFlat = wasmOutlines.map((o) => o.map((sp) => flattenSubPath(sp)))
      for (let i = 0; i < nodes.length; i++) {
        samePaths(wasmOutlines[i], tsOutlines[i], `outline ${nodes[i].type}`, close)
        sameSvg(wasmSvg[i], tsSvg[i], `svg ${nodes[i].type}`)
        expect(wasmFlat[i].length).toBe(tsFlat[i].length)
        for (let k = 0; k < wasmFlat[i].length; k++) {
          samePoints(wasmFlat[i][k], tsFlat[i][k], `flat ${nodes[i].type}[${k}]`)
        }
      }
    } finally {
      setEngineBackend('shapes', 'ts')
    }
  })
})
