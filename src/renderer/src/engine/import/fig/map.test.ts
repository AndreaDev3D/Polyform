// The mapper: geometry, tree rebuilding, and what it admits it lost.
//
// The synthetic documents here are shaped like the real ones (checked against
// three exports), which is what lets these run without shipping somebody's
// design. The real-file check lives in fig.test.ts behind POLYFORM_FIG.

import { describe, expect, it } from 'vitest'
import { networkFromPaths, parsePathCommands, FIG_PATH_OP } from './geometry'
import { buildFigTree, describeFigReport, figImageHash, mapFigDocument } from './map'
import type { KiwiObject } from '../../../../../shared/fig/kiwi'

/** Build a geometry blob the way Figma does: op byte then float32s, LE. */
function blob(...cmds: [number, ...number[]][]): Uint8Array {
  const size = cmds.reduce((n, c) => n + 1 + (c.length - 1) * 4, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let o = 0
  for (const [op, ...args] of cmds) {
    out[o++] = op
    for (const a of args) {
      view.setFloat32(o, a, true)
      o += 4
    }
  }
  return out
}

const RECT_1024 = blob(
  [FIG_PATH_OP.MOVE, 0, 0],
  [FIG_PATH_OP.LINE, 1024, 0],
  [FIG_PATH_OP.LINE, 1024, 1024],
  [FIG_PATH_OP.LINE, 0, 1024],
  [FIG_PATH_OP.LINE, 0, 0],
  [FIG_PATH_OP.CLOSE],
)

describe('fig path geometry', () => {
  it('parses the command stream a 1024×1024 fill actually contains', () => {
    // 46 bytes: this is the real blob from OmniTecta.fig, rebuilt.
    expect(RECT_1024.length).toBe(46)
    const { commands, usedInferredOp } = parsePathCommands(RECT_1024)
    expect(usedInferredOp).toBe(false)
    expect(commands.map((c) => c.op)).toEqual([0x01, 0x02, 0x02, 0x02, 0x02, 0x00])
    expect(commands[1].args).toEqual([1024, 0])
  })

  it('refuses an unknown op instead of producing half a shape', () => {
    expect(() => parsePathCommands(new Uint8Array([0x09, 0, 0, 0, 0]))).toThrow(/unknown path op 0x9/)
  })

  it('refuses a truncated command', () => {
    expect(() => parsePathCommands(new Uint8Array([FIG_PATH_OP.LINE, 0, 0]))).toThrow(/needs 8 bytes, 2 remain/)
  })

  it('closes a contour without leaving a duplicate point on top of the start', () => {
    const net = networkFromPaths([parsePathCommands(RECT_1024)])
    // Four corners, four edges, and the loop is closed.
    expect(net.vertices).toHaveLength(4)
    expect(net.edges).toHaveLength(4)
    const last = net.edges[net.edges.length - 1]
    expect(last.v1).toBe(net.edges[0].v0)
    expect(net.vertices.map((v) => [v.x, v.y])).toEqual([
      [0, 0],
      [1024, 0],
      [1024, 1024],
      [0, 1024],
    ])
  })

  it('keeps cubic control points as absolute node-local points', () => {
    const net = networkFromPaths([
      parsePathCommands(blob([FIG_PATH_OP.MOVE, 64, 32], [FIG_PATH_OP.CUBIC, 64, 49.67, 49.67, 64, 32, 64])),
    ])
    expect(net.edges).toHaveLength(1)
    expect(net.edges[0].cp0).toEqual({ x: 64, y: Math.fround(49.67) })
    expect(net.edges[0].cp1).toEqual({ x: Math.fround(49.67), y: 64 })
  })

  it('elevates a quadratic to the exactly equivalent cubic', () => {
    // c1 = p0 + 2/3(q − p0), c2 = p1 + 2/3(q − p1) — degree elevation, not a fit.
    const net = networkFromPaths([parsePathCommands(blob([FIG_PATH_OP.MOVE, 0, 0], [FIG_PATH_OP.QUAD, 30, 0, 30, 30]))])
    expect(net.edges[0].cp0).toEqual({ x: 20, y: 0 })
    expect(net.edges[0].cp1).toEqual({ x: 30, y: 10 })
  })

  it('makes one node out of several contours (a donut stays one shape)', () => {
    const inner = blob(
      [FIG_PATH_OP.MOVE, 10, 10],
      [FIG_PATH_OP.LINE, 20, 10],
      [FIG_PATH_OP.LINE, 20, 20],
      [FIG_PATH_OP.CLOSE],
    )
    const net = networkFromPaths([parsePathCommands(RECT_1024), parsePathCommands(inner)])
    expect(net.vertices).toHaveLength(7)
    // Contours are disconnected: no edge joins the outer loop to the inner one.
    const outerIds = new Set(net.vertices.slice(0, 4).map((v) => v.id))
    expect(net.edges.some((e) => outerIds.has(e.v0) !== outerIds.has(e.v1))) .toBe(false)
  })
})

// ---------------------------------------------------------------------------

const guid = (session: number, local: number) => ({ sessionID: session, localID: local })

function figDoc(nodes: KiwiObject[], blobs: Uint8Array[] = []): KiwiObject {
  return { nodeChanges: nodes, blobs: blobs.map((b) => ({ bytes: b })) } as unknown as KiwiObject
}

describe('fig tree', () => {
  it('rebuilds the hierarchy from parentGuid, not from array order', () => {
    const roots = buildFigTree([
      { guid: guid(1, 3), parentIndex: { guid: guid(1, 2), position: '!' } },
      { guid: guid(1, 1) },
      { guid: guid(1, 2), parentIndex: { guid: guid(1, 1), position: '!' } },
    ] as unknown as KiwiObject[])
    expect(roots).toHaveLength(1)
    expect(roots[0].guid).toBe('1:1')
    expect(roots[0].children[0].guid).toBe('1:2')
    expect(roots[0].children[0].children[0].guid).toBe('1:3')
  })

  it('orders siblings by the fractional index STRING', () => {
    // '!' < '"' < '#' lexicographically; as numbers they are meaningless.
    const roots = buildFigTree([
      { guid: guid(1, 1) },
      { guid: guid(1, 20), parentIndex: { guid: guid(1, 1), position: '#' } },
      { guid: guid(1, 30), parentIndex: { guid: guid(1, 1), position: '!' } },
      { guid: guid(1, 40), parentIndex: { guid: guid(1, 1), position: '"' } },
    ] as unknown as KiwiObject[])
    expect(roots[0].children.map((c) => c.guid)).toEqual(['1:30', '1:40', '1:20'])
  })
})

describe('fig document mapping', () => {
  const frame = (over: Record<string, unknown> = {}): KiwiObject =>
    ({
      guid: guid(1, 1),
      type: 'FRAME',
      name: 'Frame 1',
      size: { x: 1024, y: 1024 },
      transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 20 },
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }],
      ...over,
    }) as unknown as KiwiObject

  it('unwraps DOCUMENT and CANVAS instead of turning them into frames', () => {
    const doc = figDoc([
      { guid: guid(1, 1), type: 'DOCUMENT' },
      { guid: guid(1, 2), type: 'CANVAS', parentIndex: { guid: guid(1, 1), position: '!' } },
      { ...frame(), guid: guid(1, 3), parentIndex: { guid: guid(1, 2), position: '!' } },
    ] as unknown as KiwiObject[])
    const { bundle, report } = mapFigDocument(doc)
    expect(bundle.rootIds).toHaveLength(1)
    expect(bundle.nodes[bundle.rootIds[0]].type).toBe('FRAME')
    expect(report.pages).toBe(1)
    expect(report.nodesRead).toBe(3)
    expect(report.nodesCreated).toBe(1)
  })

  it('carries position, size, rotation, fill, opacity and blend mode across', () => {
    const doc = figDoc([
      frame({
        opacity: 0.5,
        blendMode: 'MULTIPLY',
        transform: { m00: 0, m01: -1, m02: 10, m10: 1, m11: 0, m12: 20 }, // 90°
      }),
    ])
    const { bundle } = mapFigDocument(doc)
    const node = bundle.nodes[bundle.rootIds[0]]
    expect(node.x).toBe(10)
    expect(node.y).toBe(20)
    expect(Math.round(node.rotation)).toBe(90)
    expect(node.width).toBe(1024)
    expect(node.opacity).toBe(0.5)
    expect(node.blendMode).toBe('MULTIPLY')
    expect(node.fills[0]).toMatchObject({ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } })
  })

  it('keeps a rounded rectangle parametric rather than flattening it to a path', () => {
    const doc = figDoc([
      {
        guid: guid(1, 1),
        type: 'ROUNDED_RECTANGLE',
        name: 'Card',
        size: { x: 200, y: 100 },
        rectangleTopLeftCornerRadius: 8,
        rectangleTopRightCornerRadius: 8,
        rectangleBottomRightCornerRadius: 0,
        rectangleBottomLeftCornerRadius: 0,
      },
    ] as unknown as KiwiObject[])
    // One call: ids are minted per import, so two calls give two documents.
    const { bundle } = mapFigDocument(doc)
    const node = bundle.nodes[bundle.rootIds[0]]
    expect(node.type).toBe('RECTANGLE')
    if (node.type === 'RECTANGLE') expect(node.cornerRadius).toEqual({ tl: 8, tr: 8, br: 0, bl: 0 })
  })

  it('imports a VECTOR from its own flattened geometry', () => {
    const doc = figDoc(
      [
        {
          guid: guid(1, 1),
          type: 'VECTOR',
          name: 'Rectangle 1',
          size: { x: 1024, y: 1024 },
          fillGeometry: [{ windingRule: 'EVENODD', commandsBlob: 0, styleID: 0 }],
        },
      ] as unknown as KiwiObject[],
      [RECT_1024],
    )
    const { bundle } = mapFigDocument(doc)
    const node = bundle.nodes[bundle.rootIds[0]]
    expect(node.type).toBe('VECTOR')
    if (node.type === 'VECTOR') {
      expect(node.network.vertices).toHaveLength(4)
      expect(node.windingRule).toBe('EVENODD')
    }
  })

  it('flattens a boolean operation and SAYS it did', () => {
    const doc = figDoc(
      [
        {
          guid: guid(1, 1),
          type: 'BOOLEAN_OPERATION',
          name: 'Union',
          size: { x: 1024, y: 1024 },
          fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: 0 }],
        },
      ] as unknown as KiwiObject[],
      [RECT_1024],
    )
    const { bundle, report } = mapFigDocument(doc)
    expect(bundle.nodes[bundle.rootIds[0]].type).toBe('VECTOR')
    expect(Object.keys(report.approximations)).toContain('boolean operation flattened to a path (operands not preserved)')
  })

  it('reports a node it cannot make anything of, and keeps its children', () => {
    const doc = figDoc([
      { guid: guid(1, 1), type: 'SLICE', name: 'Slice 1', size: { x: 10, y: 10 } },
      { ...frame(), guid: guid(1, 2), parentIndex: { guid: guid(1, 1), position: '!' } },
    ] as unknown as KiwiObject[])
    const { bundle, report } = mapFigDocument(doc)
    expect(report.skipped.SLICE).toBe(1)
    expect(bundle.rootIds).toHaveLength(1)
    expect(bundle.nodes[bundle.rootIds[0]].name).toBe('Frame 1')
  })

  it('uses an image fill when the bitmap came with the file, and reports it when not', () => {
    const hash = [0x5c, 0xd4, 0x5b, 0x52]
    const withImage = (map: Map<string, string>) =>
      mapFigDocument(
        figDoc([
          {
            guid: guid(1, 1),
            type: 'ROUNDED_RECTANGLE',
            name: 'Photo',
            size: { x: 100, y: 100 },
            fillPaints: [{ type: 'IMAGE', visible: true, opacity: 1, imageScaleMode: 'FILL', image: { hash } }],
          },
        ] as unknown as KiwiObject[]),
        map,
      )
    const good = withImage(new Map([['5cd45b52', 'sha256-of-ours']]))
    expect(good.bundle.nodes[good.bundle.rootIds[0]].fills[0]).toMatchObject({ type: 'IMAGE', assetHash: 'sha256-of-ours', scaleMode: 'FILL' })
    const missing = withImage(new Map())
    expect(missing.bundle.nodes[missing.bundle.rootIds[0]].fills).toHaveLength(0)
    expect(Object.keys(missing.report.skipped)).toContain('image fill whose bitmap was not in the archive')
  })

  it('hexes the SHA-1 byte array an image fill points with', () => {
    expect(figImageHash([0x5c, 0xd4, 0x5b, 0x52])).toBe('5cd45b52')
    expect(figImageHash('5CD45B52A1A61A837467D8A3C59F47DAB5599962')).toBe('5cd45b52a1a61a837467d8a3c59f47dab5599962')
  })

  it('summarises an import in lines a person can read', () => {
    const lines = describeFigReport({
      pages: 2,
      nodesRead: 10,
      nodesCreated: 8,
      images: 1,
      approximations: { 'text re-shaped by this engine (line breaks may differ)': 3 },
      skipped: { SLICE: 2 },
    })
    expect(lines[0]).toBe('8 layers from 10 nodes across 2 pages.')
    expect(lines.join(' ')).toContain('Approximated: text re-shaped by this engine (line breaks may differ) (×3)')
    expect(lines.join(' ')).toContain('Not imported: SLICE (×2)')
  })
})

// --- optional: map a real export -------------------------------------------
//
// Skipped unless POLYFORM_FIG points at one. Asserts the health properties a
// mapper can plausibly get wrong while still producing a tree that looks fine in
// a log: non-finite coordinates, and a bounding box so large that framing the
// import puts the camera nowhere.
const REAL_FIG = process.env.POLYFORM_FIG
describe.skipIf(!REAL_FIG)('mapping a real .fig export', () => {
  it('produces finite geometry and a sane bounding box', async () => {
    const [{ readFileSync }, zlib, { readFig }] = await Promise.all([
      import('node:fs'),
      import('node:zlib'),
      import('../../../../../shared/fig/container'),
    ])
    const doc = readFig(new Uint8Array(readFileSync(REAL_FIG!)), {
      inflateRaw: (b) => new Uint8Array(zlib.inflateRawSync(b)),
      zstd: (b) => new Uint8Array(zlib.zstdDecompressSync(b)),
    })
    const { bundle, bounds, report } = mapFigDocument(doc.root)
    const nodes = Object.values(bundle.nodes)
    const bad = nodes.filter((n) => ![n.x, n.y, n.width, n.height, n.rotation].every(Number.isFinite))
    const vectors = nodes.filter((n) => n.type === 'VECTOR')
    const badPoints = vectors.filter((n) =>
      n.type === 'VECTOR' && n.network.vertices.some((v) => !Number.isFinite(v.x) || !Number.isFinite(v.y)),
    )
    const types = new Map<string, number>()
    for (const n of nodes) types.set(n.type, (types.get(n.type) ?? 0) + 1)
    console.log(
      [
        `  file:    ${REAL_FIG}`,
        `  created: ${report.nodesCreated}/${report.nodesRead}  roots ${bundle.rootIds.length}`,
        `  types:   ${[...types].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ')}`,
        `  bounds:  x=${bounds.x.toFixed(0)} y=${bounds.y.toFixed(0)} w=${bounds.w.toFixed(0)} h=${bounds.h.toFixed(0)}`,
        `  vectors: ${vectors.length}, total vertices ${vectors.reduce((n, v) => n + (v.type === 'VECTOR' ? v.network.vertices.length : 0), 0)}`,
        `  bad:     ${bad.length} nodes with non-finite geometry, ${badPoints.length} vectors with non-finite points`,
        `  skipped: ${JSON.stringify(report.skipped)}`,
      ].join('\n'),
    )
    expect(bad).toEqual([])
    expect(badPoints).toEqual([])
    // A design is not 10 million units across; that would mean a transform was
    // misread and framing the import would show empty canvas.
    expect(bounds.w).toBeLessThan(1e6)
    expect(bounds.h).toBeLessThan(1e6)
  })
})
