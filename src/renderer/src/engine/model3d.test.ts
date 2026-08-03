// v0.5 MODEL3D node tests (ADR-020): schema v4 round-tripping, the v3
// upgrade path, geometry/hit-test treatment, and the snapshot cache's
// keying rules. The offscreen island itself needs a GPU and is covered by
// the POLYFORM_3D_TEST harness instead.

import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import { decodeScene, encodeScene, migrateDocument } from './serialization'
import { preciseHit } from './hit-test'
import { nodeOutline } from './shapes'
import { SCHEMA_VERSION, createNode, defaultPose } from './types'
import type { Model3dNode, NodeId, PolyformDocument } from './types'
import { snapshotSpec } from '../render3d/snapshots'
import { isSplatFormat } from '../render3d/island'

function model(name = 'Model'): Model3dNode {
  const node = createNode('MODEL3D', name) as Model3dNode
  node.assetHash = 'a'.repeat(64)
  node.width = 300
  node.height = 200
  return node
}

describe('MODEL3D node type (schema v4)', () => {
  it('defaults to a framed studio-lit GLB with no paints of its own', () => {
    const node = createNode('MODEL3D', 'M') as Model3dNode
    expect(node.format).toBe('GLB')
    expect(node.lighting).toBe('STUDIO')
    expect(node.upright).toBe(true)
    expect(node.camera).toEqual(defaultPose())
    // The render fills the box; fills/strokes would double-paint it.
    expect(node.fills).toEqual([])
    expect(node.strokes).toEqual([])
  })

  it('round-trips through scene.bin with pose and lighting intact', () => {
    const scene = new SceneGraph()
    const node = model('Coffee Machine')
    node.format = 'SPZ'
    node.lighting = 'DRAMATIC'
    node.upright = false
    node.camera = { yaw: -33.5, pitch: 12.25, distance: 1.75, fov: 55 }
    scene.addNode(node, null, 0)

    const decoded = decodeScene(encodeScene(scene.doc))
    const back = decoded.nodes[node.id] as Model3dNode
    expect(back.type).toBe('MODEL3D')
    expect(back.assetHash).toBe(node.assetHash)
    expect(back.format).toBe('SPZ')
    expect(back.lighting).toBe('DRAMATIC')
    expect(back.upright).toBe(false)
    expect(back.camera).toEqual({ yaw: -33.5, pitch: 12.25, distance: 1.75, fov: 55 })
    expect(decoded.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('upgrades a v3 document without touching its nodes', () => {
    const rect = createNode('RECTANGLE', 'R')
    const v3 = {
      schemaVersion: 3,
      nodes: { [rect.id]: rect },
      pages: [{ id: 'p1', name: 'Page 1', rootIds: [rect.id], guides: [], viewport: null }],
      activePageId: 'p1',
      styles: { colors: [], texts: [], effects: [] },
      libraries: [],
    } as unknown as PolyformDocument & { rootIds?: NodeId[] }
    const before = JSON.stringify(v3.nodes)
    const doc = migrateDocument(v3)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(JSON.stringify(doc.nodes)).toBe(before)
  })

  it('behaves as a plain box for outline and hit-testing', () => {
    const scene = new SceneGraph()
    const node = model()
    scene.addNode(node, null, 0)
    const outline = nodeOutline(node)
    expect(outline).toHaveLength(1)
    expect(outline[0].closed).toBe(true)
    expect(outline[0].anchors.map((a) => [a.p.x, a.p.y])).toEqual([
      [0, 0],
      [300, 0],
      [300, 200],
      [0, 200],
    ])
    // Picks anywhere inside its box even with no fills.
    expect(preciseHit(scene, node.id, { x: 150, y: 100 }, 0)).toBe(true)
    expect(preciseHit(scene, node.id, { x: 320, y: 100 }, 0)).toBe(false)
  })
})

describe('snapshot cache keys', () => {
  it('classifies splat formats apart from meshes', () => {
    expect(isSplatFormat('GLB')).toBe(false)
    for (const f of ['PLY', 'SPZ', 'SPLAT', 'KSPLAT', 'SOG'] as const) {
      expect(isSplatFormat(f)).toBe(true)
    }
  })

  it('buckets render size so zooming does not thrash the cache', () => {
    const node = model()
    const a = snapshotSpec(node, 300, 200, 1)
    const b = snapshotSpec(node, 302, 201.3, 1)
    expect(b.width).toBe(a.width)
    expect(b.height).toBe(a.height)
    // A real zoom step still escalates resolution.
    expect(snapshotSpec(node, 300, 200, 4).width).toBeGreaterThan(a.width)
  })

  it('keeps the node box aspect ratio and caps at the snapshot limit', () => {
    const node = model()
    const spec = snapshotSpec(node, 300, 150, 1)
    expect(spec.height / spec.width).toBeCloseTo(0.5, 1)
    const huge = snapshotSpec(node, 20000, 20000, 4)
    expect(huge.width).toBeLessThanOrEqual(2048)
    expect(huge.height).toBeLessThanOrEqual(2048)
  })

  it('carries the pose so a re-orbit is a different cache entry', () => {
    const node = model()
    const a = snapshotSpec(node, 300, 200, 1)
    node.camera = { ...node.camera, yaw: node.camera.yaw + 10 }
    const b = snapshotSpec(node, 300, 200, 1)
    expect(b.pose.yaw).not.toBe(a.pose.yaw)
  })
})
