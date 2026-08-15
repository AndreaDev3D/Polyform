// Per-part fills.
//
// Three back ends read `vectorPaintGroups`, so the GROUPS are the behaviour: get
// them wrong and the colour lands on the wrong outline on the canvas, in the GPU
// mesh and in the exported SVG at once.

import { describe, expect, it } from 'vitest'
import { createNode, type Paint, type VectorNode } from './types'
import { networkParts, partKey } from './vector-parts'
import { hasPartFills, partAtPoint, vectorPaintGroups, withPartFill } from './vector-paint'

const red: Paint = { type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 0, b: 0, a: 1 } }
const blue: Paint = { type: 'SOLID', visible: true, opacity: 1, color: { r: 0, g: 0, b: 1, a: 1 } }

/** Two detached squares in one node: 0..100 and 200..300, both 100 tall. */
function twoSquares(): VectorNode {
  const node = createNode('VECTOR', 'v') as VectorNode
  node.width = 300
  node.height = 100
  node.fills = [blue]
  node.network = {
    vertices: [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 100, y: 0 },
      { id: 3, x: 100, y: 100 },
      { id: 4, x: 0, y: 100 },
      { id: 11, x: 200, y: 0 },
      { id: 12, x: 300, y: 0 },
      { id: 13, x: 300, y: 100 },
      { id: 14, x: 200, y: 100 },
    ],
    edges: [
      { id: 1, v0: 1, v1: 2, cp0: null, cp1: null },
      { id: 2, v0: 2, v1: 3, cp0: null, cp1: null },
      { id: 3, v0: 3, v1: 4, cp0: null, cp1: null },
      { id: 4, v0: 4, v1: 1, cp0: null, cp1: null },
      { id: 11, v0: 11, v1: 12, cp0: null, cp1: null },
      { id: 12, v0: 12, v1: 13, cp0: null, cp1: null },
      { id: 13, v0: 13, v1: 14, cp0: null, cp1: null },
      { id: 14, v0: 14, v1: 11, cp0: null, cp1: null },
    ],
  }
  return node
}

describe('per-part fills', () => {
  it('stays out of the way when nothing is painted', () => {
    // Null, not "one group with everything": every back end keeps its ordinary
    // single-pass fill, which is cheaper and is the case for almost every shape
    // that will ever exist.
    expect(vectorPaintGroups(twoSquares())).toBeNull()
    expect(hasPartFills(twoSquares())).toBe(false)
  })

  it('paints one part and leaves the other on the node colour', () => {
    const node = twoSquares()
    node.partFills = { '11': [red] }
    const groups = vectorPaintGroups(node)
    expect(groups).toHaveLength(2)
    // Unpainted first, so a per-part colour lands ON TOP where they overlap.
    expect(groups![0].key).toBe(-1)
    expect(groups![0].fills).toEqual([blue])
    expect(groups![1].key).toBe(11)
    expect(groups![1].fills).toEqual([red])
  })

  it('collects every unpainted part into ONE group', () => {
    const node = twoSquares()
    // Nothing painted here would be null, so paint a third part and check the
    // other two share a group: a gradient across them should span both, the way
    // it does on a shape with no per-part fills at all, rather than restarting
    // inside each outline.
    node.network.vertices.push(
      { id: 21, x: 400, y: 0 },
      { id: 22, x: 500, y: 0 },
      { id: 23, x: 500, y: 100 },
      { id: 24, x: 400, y: 100 },
    )
    node.network.edges.push(
      { id: 21, v0: 21, v1: 22, cp0: null, cp1: null },
      { id: 22, v0: 22, v1: 23, cp0: null, cp1: null },
      { id: 23, v0: 23, v1: 24, cp0: null, cp1: null },
      { id: 24, v0: 24, v1: 21, cp0: null, cp1: null },
    )
    node.partFills = { '21': [red] }
    const groups = vectorPaintGroups(node)
    expect(groups).toHaveLength(2)
    expect(groups![0].key).toBe(-1)
    expect(groups![0].subpaths).toHaveLength(2)
  })

  it('names a part by its smallest anchor, and that survives edits elsewhere', () => {
    const node = twoSquares()
    const keys = networkParts(node.network).map(partKey)
    expect(keys).toEqual([1, 11])
    // Add a point to the FIRST part: ids only ever go up, so the name is
    // unchanged and a colour on it stays where it was put.
    node.network.vertices.push({ id: 99, x: 50, y: 0 })
    node.network.edges[0] = { id: 1, v0: 1, v1: 99, cp0: null, cp1: null }
    node.network.edges.push({ id: 99, v0: 99, v1: 2, cp0: null, cp1: null })
    expect(networkParts(node.network).map(partKey)).toEqual([1, 11])
  })

  it('falls back to the node colour when a painted part is gone', () => {
    const node = twoSquares()
    // A key naming nothing — what a knife cut or a deleted anchor leaves behind.
    node.partFills = { '404': [red] }
    const groups = vectorPaintGroups(node)
    // Both parts on the node fill, and no group conjured for the missing one.
    expect(groups).toHaveLength(1)
    expect(groups![0].key).toBe(-1)
    expect(groups![0].fills).toEqual([blue])
  })

  it('finds the part a point is inside', () => {
    const node = twoSquares()
    expect(partAtPoint(node, { x: 50, y: 50 })).toBe(1)
    expect(partAtPoint(node, { x: 250, y: 50 })).toBe(11)
    // Between the two squares: nothing to paint, and saying so beats painting
    // whichever one happened to be nearest.
    expect(partAtPoint(node, { x: 150, y: 50 })).toBeNull()
  })

  it('picks the innermost part when one sits inside another', () => {
    const node = twoSquares()
    // A small square inside the first one — the hole of an "O", a leaf on a
    // stem. It is the one you can SEE at that point, so it is the one you meant.
    node.network.vertices.push(
      { id: 31, x: 30, y: 30 },
      { id: 32, x: 70, y: 30 },
      { id: 33, x: 70, y: 70 },
      { id: 34, x: 30, y: 70 },
    )
    node.network.edges.push(
      { id: 31, v0: 31, v1: 32, cp0: null, cp1: null },
      { id: 32, v0: 32, v1: 33, cp0: null, cp1: null },
      { id: 33, v0: 33, v1: 34, cp0: null, cp1: null },
      { id: 34, v0: 34, v1: 31, cp0: null, cp1: null },
    )
    expect(partAtPoint(node, { x: 50, y: 50 })).toBe(31)
    expect(partAtPoint(node, { x: 10, y: 50 })).toBe(1)
  })

  it('has one representation for "not painted"', () => {
    // Clearing DELETES the key rather than storing an empty list. Both render
    // identically and compare differently, and the difference survives a round
    // trip through a file.
    expect(withPartFill(undefined, 1, [red])).toEqual({ '1': [red] })
    expect(withPartFill({ '1': [red] }, 1, null)).toBeUndefined()
    expect(withPartFill({ '1': [red] }, 1, [])).toBeUndefined()
    expect(withPartFill({ '1': [red], '11': [blue] }, 1, null)).toEqual({ '11': [blue] })
  })
})
