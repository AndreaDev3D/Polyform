// The mapper: geometry, tree rebuilding, and what it admits it lost.
//
// The synthetic documents here are shaped like the real ones (checked against
// three exports), which is what lets these run without shipping somebody's
// design. The real-file check lives in fig.test.ts behind POLYFORM_FIG.

import { describe, expect, it } from 'vitest'
import { networkFromPaths, parsePathCommands, FIG_PATH_OP } from './geometry'
import { buildFigTree, describeFigReport, figImageHash, mapFigDocument } from './map'
import type { KiwiObject } from '../../../../../shared/fig/kiwi'
import { applyMat, nodeLocalMatrix } from '../../geometry'
import type { SceneNode } from '../../types'

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
    // NOT (10, 20). This test used to assert exactly that — it copied the
    // translation into x/y, which is the bug it should have caught (F-28). Figma's
    // matrix turns the box about its own top-left corner, so (10, 20) is where that
    // CORNER ends up; we store the unrotated box and turn it about its centre. The
    // check that means something is corner-for-corner equality, below.
    expect(node.x).toBeCloseTo(-1014, 6)
    expect(node.y).toBeCloseTo(20, 6)
    expect(Math.round(node.rotation)).toBe(90)
    expect(node.width).toBe(1024)
    expect(node.opacity).toBe(0.5)
    expect(node.blendMode).toBe('MULTIPLY')
    expect(node.fills[0]).toMatchObject({ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } })
  })

  /**
   * The only claim worth making about a transform: our node covers the same four
   * points of the parent's space that Figma's matrix sends its box to.
   *
   * Anything weaker passes while the design is scrambled — the first import got
   * every number finite, every bounding box sane, and still put a 90°-rotated bar
   * 260 units from where it belonged.
   */
  const cornersAgree = (fig: Record<string, number>, w: number, h: number, node: SceneNode): void => {
    const local = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ]
    const theirs = local.map((p) => ({
      x: fig.m00 * p.x + fig.m01 * p.y + fig.m02,
      y: fig.m10 * p.x + fig.m11 * p.y + fig.m12,
    }))
    const m = nodeLocalMatrix(node.x, node.y, node.width, node.height, node.rotation, node.flipH, node.flipV)
    const ours = local.map((p) => applyMat(m, p))
    for (let i = 0; i < 4; i++) {
      expect(ours[i].x).toBeCloseTo(theirs[i].x, 6)
      expect(ours[i].y).toBeCloseTo(theirs[i].y, 6)
    }
  }

  it('puts a rotated box exactly where Figma puts it, corner for corner', () => {
    // The bar from Dipped.fig that gave the scrambling away: 183×338 at 90°.
    const t = { m00: 0, m01: -1, m02: 1034, m10: 1, m11: 0, m12: 511 }
    const doc = figDoc([frame({ size: { x: 183, y: 338 }, transform: t })])
    const { bundle } = mapFigDocument(doc)
    const node = bundle.nodes[bundle.rootIds[0]]
    // Hand-computed from t + M·c − c, so a wrong sign cannot hide behind the loop.
    expect(node.x).toBeCloseTo(773.5, 6)
    expect(node.y).toBeCloseTo(433.5, 6)
    cornersAgree(t, 183, 338, node)
  })

  it('keeps a mirror as a flip instead of dropping it', () => {
    // det < 0: nine nodes in one real export, every one of them silently unmirrored
    // before, because reducing the matrix to an angle throws the reflection away.
    const t = { m00: 1, m01: 0, m02: 100, m10: 0, m11: -1, m12: 200 }
    const doc = figDoc([frame({ size: { x: 60, y: 40 }, transform: t })])
    const { bundle, report } = mapFigDocument(doc)
    const node = bundle.nodes[bundle.rootIds[0]]
    expect(node.flipV).toBe(true)
    expect(node.rotation).toBe(0)
    cornersAgree(t, 60, 40, node)
    // A mirror is exact here, so it is not an approximation and must not claim to be.
    expect(Object.keys(report.approximations).join(' ')).not.toMatch(/skew/)
  })

  it('reports a scaled matrix rather than resizing a node whose geometry cannot follow', () => {
    const doc = figDoc([frame({ transform: { m00: 2, m01: 0, m02: 0, m10: 0, m11: 2, m12: 0 } })])
    const { report } = mapFigDocument(doc)
    expect(Object.keys(report.approximations).join(' ')).toMatch(/scale 2\.000× not applied/)
  })

  it('takes the stroke outline when the fill geometry points at an empty blob', () => {
    // Figma writes a fillGeometry ENTRY with a zero-byte blob for a shape with no
    // fill. Trusting the entry built a vector node with no vertices — invisible,
    // 37 of them in one real file — while the stroke outline sat in the next field.
    const doc = figDoc(
      [
        {
          guid: guid(1, 1),
          type: 'VECTOR',
          name: 'Line 1',
          size: { x: 1024, y: 1024 },
          fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: 0 }],
          strokeGeometry: [{ windingRule: 'NONZERO', commandsBlob: 1 }],
          strokePaints: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 }, opacity: 1, visible: true }],
          fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }],
          strokeWeight: 4,
        },
      ] as unknown as KiwiObject[],
      [new Uint8Array(), RECT_1024],
    )
    const { bundle } = mapFigDocument(doc)
    const node = bundle.nodes[bundle.rootIds[0]]
    expect(node.type).toBe('VECTOR')
    if (node.type === 'VECTOR') expect(node.network.vertices).toHaveLength(4)
    // The outline is the region the stroke COVERS, so it is filled with the stroke
    // paint — green here. Stroking it would outline a line, and using the node's own
    // fill paint would flood the shape black.
    expect(node.fills).toHaveLength(1)
    expect(node.fills[0]).toMatchObject({ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 } })
    expect(node.strokes).toEqual([])
  })

  // The four things a real 5000-node file got wrong, each pinned to what the file
  // itself says (F-28: an importer is only checked against its source).
  describe('what Digborn.fig proved was wrong', () => {
    const withHole = (over: Record<string, unknown> = {}): KiwiObject =>
      ({
        guid: guid(1, 1),
        type: 'BOOLEAN_OPERATION',
        booleanOperation: 'SUBTRACT',
        name: 'Subtract',
        size: { x: 1024, y: 1024 },
        // Figma's enum spells this ODD. Read from the schema embedded in a real
        // export — `WindingRule => NONZERO, ODD` — not from our own vocabulary.
        fillGeometry: [{ windingRule: 'ODD', commandsBlob: 0 }],
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }],
        ...over,
      }) as unknown as KiwiObject

    it("reads Figma's ODD as even-odd, so a subtraction keeps its hole", () => {
      const { bundle } = mapFigDocument(figDoc([withHole()], [RECT_1024]))
      const node = bundle.nodes[bundle.rootIds[0]]
      expect(node.type).toBe('VECTOR')
      // Was NONZERO for every even-odd path in every .fig ever imported, because
      // 'ODD' was compared against 'EVENODD' and quietly lost.
      if (node.type === 'VECTOR') expect(node.windingRule).toBe('EVENODD')
    })

    it('still reads NONZERO, and anything unknown, as nonzero', () => {
      const nz = mapFigDocument(figDoc([withHole({ fillGeometry: [{ windingRule: 'NONZERO', commandsBlob: 0 }] })], [RECT_1024]))
      const a = nz.bundle.nodes[nz.bundle.rootIds[0]]
      if (a.type === 'VECTOR') expect(a.windingRule).toBe('NONZERO')
      const junk = mapFigDocument(figDoc([withHole({ fillGeometry: [{ windingRule: 'WAT', commandsBlob: 0 }] })], [RECT_1024]))
      const b = junk.bundle.nodes[junk.bundle.rootIds[0]]
      if (b.type === 'VECTOR') expect(b.windingRule).toBe('NONZERO')
    })

    it('carries a mask across as a mask', () => {
      const doc = figDoc(
        [
          { guid: guid(1, 1), type: 'FRAME', name: 'House_Roof_Top', size: { x: 1000, y: 1000 } },
          {
            guid: guid(1, 2),
            type: 'ROUNDED_RECTANGLE',
            name: 'Rectangle 299',
            size: { x: 500, y: 500 },
            mask: true,
            parentIndex: { guid: guid(1, 1), position: '!' },
          },
          {
            guid: guid(1, 3),
            type: 'ROUNDED_RECTANGLE',
            name: 'Roof',
            size: { x: 1000, y: 1000 },
            parentIndex: { guid: guid(1, 1), position: '"' },
          },
        ] as unknown as KiwiObject[],
      )
      const { bundle, report } = mapFigDocument(doc)
      const nodes = Object.values(bundle.nodes)
      const mask = nodes.find((n) => n.name === 'Rectangle 299')
      expect(mask?.isMask).toBe(true)
      // And it stays BELOW the layer it clips, which is what makes it clip it.
      const frame = nodes.find((n) => n.name === 'House_Roof_Top')
      if (frame?.type === 'FRAME') {
        expect(frame.children.map((id) => bundle.nodes[id].name)).toEqual(['Rectangle 299', 'Roof'])
      }
      // Ours is a clip; theirs defaults to an alpha mask. Same for a solid shape,
      // hard-edged where theirs would fade — so it is declared.
      expect(Object.keys(report.approximations)).toContain('alpha mask imported as a clipping path')
    })

    it('keeps what is inside a component instead of deleting it as boolean operands', () => {
      const doc = figDoc([
        { guid: guid(1, 1), type: 'SYMBOL', name: 'Bark_Tilemap', size: { x: 400, y: 400 } },
        {
          guid: guid(1, 2),
          type: 'ROUNDED_RECTANGLE',
          name: 'Tile',
          size: { x: 64, y: 64 },
          parentIndex: { guid: guid(1, 1), position: '!' },
        },
      ] as unknown as KiwiObject[])
      const { bundle, report } = mapFigDocument(doc)
      const symbol = Object.values(bundle.nodes).find((n) => n.name === 'Bark_Tilemap')
      expect(symbol?.type).toBe('FRAME')
      // The whole point: the child survived. A SYMBOL used to map to a bare path and
      // then have its contents dropped under a comment about operands.
      if (symbol?.type === 'FRAME') {
        expect(symbol.children.map((id) => bundle.nodes[id].name)).toEqual(['Tile'])
      }
      expect(Object.keys(report.approximations)).toContain('component imported as a plain frame (no link to its instances)')
    })

    it("leaves Figma's internal-only canvas out of the document", () => {
      const doc = figDoc([
        { guid: guid(1, 1), type: 'DOCUMENT' },
        { guid: guid(1, 2), type: 'CANVAS', name: 'Assets', parentIndex: { guid: guid(1, 1), position: '!' } },
        {
          guid: guid(1, 3),
          type: 'ROUNDED_RECTANGLE',
          name: 'Keeper',
          size: { x: 10, y: 10 },
          parentIndex: { guid: guid(1, 2), position: '!' },
        },
        {
          guid: guid(1, 4),
          type: 'CANVAS',
          name: 'Internal Only Canvas',
          internalOnly: true,
          parentIndex: { guid: guid(1, 1), position: '"' },
        },
        {
          guid: guid(1, 5),
          type: 'ROUNDED_RECTANGLE',
          name: 'Debris',
          size: { x: 10, y: 10 },
          parentIndex: { guid: guid(1, 4), position: '!' },
        },
      ] as unknown as KiwiObject[])
      const { bundle, report, pages } = mapFigDocument(doc)
      const names = Object.values(bundle.nodes).map((n) => n.name)
      expect(names).toContain('Keeper')
      // 477 pieces of debris were the biggest "page" in the real import.
      expect(names).not.toContain('Debris')
      expect(pages.map((p) => p.name)).toEqual(['Assets'])
      expect(report.pages).toBe(1)
      expect(Object.keys(report.skipped)).toContain(
        "Figma's internal-only canvas (component definitions and deleted nodes)",
      )
    })

    it('reports one page entry per Figma page, at the coordinates the file gave them', () => {
      // Two pages whose contents overlap exactly. They used to be shoved sideways to
      // stop them colliding on one Polyform page; now each gets its own page and
      // keeps its own coordinates.
      const page = (id: number, pos: string, name: string): KiwiObject =>
        ({ guid: guid(1, id), type: 'CANVAS', name, parentIndex: { guid: guid(1, 1), position: pos } }) as unknown as KiwiObject
      const rect = (id: number, parent: number): KiwiObject =>
        ({
          guid: guid(1, id),
          type: 'ROUNDED_RECTANGLE',
          name: `R${id}`,
          size: { x: 100, y: 100 },
          transform: { m00: 1, m01: 0, m02: 50, m10: 0, m11: 1, m12: 60 },
          parentIndex: { guid: guid(1, parent), position: '!' },
        }) as unknown as KiwiObject
      const { bundle, pages } = mapFigDocument(
        figDoc([
          { guid: guid(1, 1), type: 'DOCUMENT' } as unknown as KiwiObject,
          page(2, '!', 'Assets'),
          rect(10, 2),
          page(3, '"', 'Banner'),
          rect(11, 3),
        ]),
      )
      expect(pages.map((p) => `${p.name}:${p.rootIds.length}`)).toEqual(['Assets:1', 'Banner:1'])
      const [a, b] = pages.map((p) => bundle.nodes[p.rootIds[0]])
      expect([a.x, a.y]).toEqual([50, 60])
      expect([b.x, b.y]).toEqual([50, 60])
    })
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
          // 'ODD' is what Figma writes. This fixture said 'EVENODD' — OUR word for
          // the rule, which never appears in a .fig — so it asserted our own
          // assumption back at us and passed while every real even-odd path was
          // being read as nonzero (F-32).
          fillGeometry: [{ windingRule: 'ODD', commandsBlob: 0, styleID: 0 }],
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
    const { bundle, bounds, report, idByGuid, pages } = mapFigDocument(doc.root)
    const nodes = Object.values(bundle.nodes)

    // The check that would have caught the scrambling (F-28): hold every mapped
    // node against the matrix it came from and demand the same four points of the
    // parent's space. Runs over the whole file, so one wrong pivot fails it.
    const walkFig = (list: ReturnType<typeof buildFigTree>, out: KiwiObject[] = []): KiwiObject[] => {
      for (const n of list) {
        out.push(n.raw)
        walkFig(n.children, out)
      }
      return out
    }
    const raws = new Map<string, KiwiObject>()
    for (const n of walkFig(buildFigTree((doc.root.nodeChanges ?? []) as KiwiObject[]))) {
      const g = n.guid as { sessionID?: number; localID?: number } | undefined
      if (g && typeof g.sessionID === 'number') raws.set(`${g.sessionID}:${g.localID}`, n)
    }
    let compared = 0
    const misplaced: string[] = []
    for (const [guidKey, id] of idByGuid) {
      const raw = raws.get(guidKey)
      const node = bundle.nodes[id]
      const t = raw?.transform as Record<string, number> | undefined
      if (!raw || !node || !t) continue
      const m00 = t.m00 ?? 1
      const m01 = t.m01 ?? 0
      const m10 = t.m10 ?? 0
      const m11 = t.m11 ?? 1
      // Only nodes our model can express exactly: unit scale, no skew. A scaled or
      // skewed one is reported as an approximation, and comparing it would be
      // asserting the approximation rather than the placement.
      if (Math.abs(Math.hypot(m00, m10) - 1) > 1e-3 || Math.abs(Math.hypot(m01, m11) - 1) > 1e-3) continue
      const w = node.width
      const h = node.height
      const corners = [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ]
      const m = nodeLocalMatrix(node.x, node.y, w, h, node.rotation, node.flipH, node.flipV)
      for (const p of corners) {
        const theirs = {
          x: m00 * p.x + m01 * p.y + (t.m02 ?? 0),
          y: m10 * p.x + m11 * p.y + (t.m12 ?? 0),
        }
        const ours = applyMat(m, p)
        if (Math.abs(ours.x - theirs.x) > 0.01 || Math.abs(ours.y - theirs.y) > 0.01) {
          misplaced.push(
            `${node.type} "${node.name}" corner ${p.x},${p.y}: ours ${ours.x.toFixed(1)},${ours.y.toFixed(1)} vs theirs ${theirs.x.toFixed(1)},${theirs.y.toFixed(1)}`,
          )
          break
        }
      }
      compared++
    }
    // A vector node with no vertices is an invisible hole where a shape was.
    const emptyVectors = nodes.filter((n) => n.type === 'VECTOR' && n.network.vertices.length === 0)
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
        `  placed:  ${compared} nodes compared corner-for-corner against Figma's matrix, ${misplaced.length} misplaced`,
        `  empty:   ${emptyVectors.length} vector nodes with no vertices`,
        `  skipped: ${JSON.stringify(report.skipped)}`,
        `  approx:  ${JSON.stringify(report.approximations)}`,
      ].join('\n'),
    )
    expect(bad).toEqual([])
    expect(badPoints).toEqual([])
    expect(misplaced).toEqual([])
    expect(emptyVectors.map((n) => n.name)).toEqual([])
    // Worth asserting that the comparison had something to compare: a matcher that
    // silently skipped every node would pass while the file arrived scrambled.
    expect(compared).toBeGreaterThan(10)
    // A design is not 10 million units across; that would mean a transform was
    // misread and framing the import would show empty canvas.
    expect(bounds.w).toBeLessThan(1e6)
    expect(bounds.h).toBeLessThan(1e6)
  })
})
