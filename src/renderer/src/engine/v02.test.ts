// v0.2 feature tests: schema migration, pages, constraints, SVG path parsing.

import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import { migrateDocument } from './serialization'
import { applyOp, invertOp, type PatchOp } from './commands'
import { constrainChild, constrainFrameChildren } from './constraints'
import { parsePathData } from './import/svg-import'
import { SCHEMA_VERSION, createNode, createPage, type FrameNode, type PolyformDocument, type NodeId } from './types'
import { IDENTITY } from './geometry'

describe('schema migration v1 -> v2', () => {
  it('wraps a v1 single-root document into a page', () => {
    const rect = createNode('RECTANGLE', 'R')
    const v1 = {
      schemaVersion: 1,
      nodes: { [rect.id]: rect },
      rootIds: [rect.id],
    } as unknown as PolyformDocument & { rootIds?: NodeId[] }
    const doc = migrateDocument(v1)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.pages).toHaveLength(1)
    expect(doc.pages[0].rootIds).toEqual([rect.id])
    expect(doc.activePageId).toBe(doc.pages[0].id)
    expect(doc.styles.colors).toEqual([])
    const scene = new SceneGraph(doc)
    expect(scene.rootIds()).toEqual([rect.id])
    expect(scene.topLevelAncestor(rect.id)).toBe(rect.id)
  })
})

describe('pages', () => {
  it('page ops apply and invert', () => {
    const scene = new SceneGraph()
    const page = createPage('Page 2')
    const addOp: PatchOp = { kind: 'page-add', index: 1, page }
    applyOp(scene, addOp)
    expect(scene.doc.pages).toHaveLength(2)
    scene.setActivePage(page.id)
    const rect = createNode('RECTANGLE', 'R')
    scene.addNode(rect, null, 0)
    expect(scene.parentOf(rect.id)).toBe(page.id)
    expect(scene.getPage(page.id)!.rootIds).toEqual([rect.id])
    // Ops recorded against page ids land on the right page after switching.
    scene.setActivePage(scene.doc.pages[0].id)
    scene.removeNode(rect.id)
    applyOp(scene, { kind: 'add', parentId: page.id, index: 0, node: rect })
    expect(scene.getPage(page.id)!.rootIds).toEqual([rect.id])
    // Invert page-add removes it again.
    scene.removeNode(rect.id)
    applyOp(scene, invertOp(addOp))
    expect(scene.doc.pages).toHaveLength(1)
  })
})

describe('constraints', () => {
  const snap = { x: 100, y: 50, width: 50, height: 20 }

  it('MIN keeps position, MAX follows the far edge', () => {
    const a = createNode('RECTANGLE', 'A')
    a.constraintsH = 'MIN'
    constrainChild(a, snap, 400, 300, 500, 300)
    expect(a.x).toBe(100)
    const b = createNode('RECTANGLE', 'B')
    b.constraintsH = 'MAX'
    constrainChild(b, snap, 400, 300, 500, 300)
    expect(b.x).toBe(200)
  })

  it('CENTER splits the delta, STRETCH grows, SCALE multiplies', () => {
    const c = createNode('RECTANGLE', 'C')
    c.constraintsH = 'CENTER'
    constrainChild(c, snap, 400, 300, 500, 300)
    expect(c.x).toBe(150)
    const s = createNode('RECTANGLE', 'S')
    s.constraintsH = 'STRETCH'
    constrainChild(s, snap, 400, 300, 500, 300)
    expect(s.x).toBe(100)
    expect(s.width).toBe(150)
    const sc = createNode('RECTANGLE', 'SC')
    sc.constraintsH = 'SCALE'
    constrainChild(sc, snap, 400, 300, 800, 300)
    expect(sc.x).toBe(200)
    expect(sc.width).toBe(100)
  })

  it('cascades through nested plain frames', () => {
    const scene = new SceneGraph()
    const outer = createNode('FRAME', 'Outer') as FrameNode
    outer.width = 400
    outer.height = 300
    scene.addNode(outer, null, 0)
    const inner = createNode('FRAME', 'Inner') as FrameNode
    inner.x = 0
    inner.y = 0
    inner.width = 200
    inner.height = 300
    inner.constraintsH = 'STRETCH'
    scene.addNode(inner, outer.id, 0)
    const leaf = createNode('RECTANGLE', 'Leaf')
    leaf.x = 150
    leaf.y = 10
    leaf.width = 40
    leaf.height = 40
    leaf.constraintsH = 'MAX'
    scene.addNode(leaf, inner.id, 0)

    const rects = new Map([
      [inner.id, { x: 0, y: 0, width: 200, height: 300 }],
      [leaf.id, { x: 150, y: 10, width: 40, height: 40 }],
    ])
    outer.width = 500
    constrainFrameChildren(scene, outer, (id) => rects.get(id) ?? null, 400, 300)
    expect(inner.width).toBe(300) // stretched by +100
    expect(scene.requireNode(leaf.id).x).toBe(250) // followed inner's right edge
  })
})

describe('SVG path parsing', () => {
  it('parses lines, curves and close commands', () => {
    const net = parsePathData('M 10 10 L 60 10 C 80 10 90 30 90 50 Z', IDENTITY)
    expect(net.vertices).toHaveLength(3)
    expect(net.edges).toHaveLength(3)
    expect(net.edges[1].cp0).toEqual({ x: 80, y: 10 })
    // Closed: last edge returns to the first vertex.
    expect(net.edges[2].v1).toBe(net.edges[0].v0)
  })

  it('handles relative commands and implicit repetition', () => {
    const net = parsePathData('m 0 0 10 0 10 5 h 10 v 10', IDENTITY)
    expect(net.vertices).toHaveLength(5)
    const last = net.vertices[net.vertices.length - 1]
    expect(last.x).toBe(30)
    expect(last.y).toBe(15)
  })

  it('converts quadratics and arcs to cubics', () => {
    const quad = parsePathData('M 0 0 Q 50 100 100 0', IDENTITY)
    expect(quad.edges).toHaveLength(1)
    expect(quad.edges[0].cp0).not.toBeNull()
    const arc = parsePathData('M 0 0 A 50 50 0 0 1 100 0', IDENTITY)
    expect(arc.edges.length).toBeGreaterThanOrEqual(1)
    const end = arc.vertices[arc.vertices.length - 1]
    expect(end.x).toBeCloseTo(100, 0)
    expect(end.y).toBeCloseTo(0, 0)
  })
})
