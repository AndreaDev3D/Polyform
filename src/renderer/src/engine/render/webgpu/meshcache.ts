// Per-node tessellated geometry cache for the WebGPU backend.
// Local-space fill/stroke meshes from the Rust lyon module, keyed by the
// node's geometry-affecting props plus a power-of-two zoom bucket (curve
// flattening tolerance scales with the bucket so curves stay smooth when
// zoomed in without re-tessellating every frame).

import type { SceneNode, Vec2 } from '../../types'
import type { SceneGraph } from '../../scene'
import { nodeOutline, type SubPath } from '../../shapes'
import { openStrokeOffset } from '../../paintbox'
import { booleanRings } from '../../booleans'
import { encodeSubPaths } from '../../wasm/codec'
import { wasmHandle } from '../../backend'

export interface NodeMesh {
  fillPositions: Float32Array
  fillIndices: Uint32Array
  strokePositions: Float32Array
  strokeIndices: Uint32Array
  /** INSIDE(1)/OUTSIDE(2) strokes need the stencil clip against the fill. */
  strokeAlignCode: number
}

const EMPTY = new Float32Array(0)
const EMPTY_IDX = new Uint32Array(0)

export function zoomBucket(zoom: number): number {
  const clamped = Math.max(0.125, Math.min(16, zoom))
  return Math.pow(2, Math.round(Math.log2(clamped)))
}

function geometryKey(scene: SceneGraph, node: SceneNode, bucket: number): string {
  // openStrokeOffset moves the stroke mesh, so it belongs in the key: without it a
  // cached centred band survives a change to Inside/Outside.
  const parts: unknown[] = [node.type, node.width, node.height, bucket, openStrokeOffset(node)]
  switch (node.type) {
    case 'RECTANGLE':
    case 'FRAME':
    case 'COMPONENT':
    case 'INSTANCE':
      parts.push(node.cornerRadius)
      break
    case 'POLYGON':
      parts.push(node.pointCount)
      break
    case 'STAR':
      parts.push(node.pointCount, node.innerRatio)
      break
    case 'VECTOR':
      parts.push(node.network, node.windingRule)
      break
    case 'BOOLEAN':
      // Boolean geometry derives from the whole child subtree — key on the
      // node identity + scene version instead of hashing the subtree.
      parts.push(node.id, scene.version)
      break
    default:
      break
  }
  parts.push(node.strokeWeight, node.strokeAlign, node.strokeDash)
  return JSON.stringify(parts)
}

const MAX_ENTRIES = 4096

export class MeshCache {
  /** Content-addressed: identical geometry (e.g. 100k copies of the same
   * rect, or every instance of a component) shares one mesh. */
  private entries = new Map<string, NodeMesh>()

  prune(_scene: SceneGraph): void {
    if (this.entries.size > MAX_ENTRIES) this.entries.clear()
  }

  clear(): void {
    this.entries.clear()
  }

  get(scene: SceneGraph, node: SceneNode, zoom: number, wantFill: boolean, wantStroke: boolean): NodeMesh {
    const bucket = zoomBucket(zoom)
    const key = `${wantFill ? 'f' : ''}${wantStroke ? 's' : ''}|${geometryKey(scene, node, bucket)}`
    const cached = this.entries.get(key)
    if (cached) return cached
    const mesh = this.build(scene, node, bucket, wantFill, wantStroke)
    this.entries.set(key, mesh)
    return mesh
  }

  /** Sharp rectangles skip the WASM tessellator entirely (the dominant node
   * population in large documents). */
  private static sharpRect(node: SceneNode, wantStroke: boolean): NodeMesh | null {
    if (node.type !== 'RECTANGLE') return null
    const r = node.cornerRadius
    if (r.tl !== 0 || r.tr !== 0 || r.br !== 0 || r.bl !== 0) return null
    if (node.strokeDash.length > 0) return null
    const w = node.width
    const h = node.height
    const fillPositions = new Float32Array([0, 0, w, 0, w, h, 0, h])
    const fillIndices = new Uint32Array([0, 1, 2, 0, 2, 3])
    let strokePositions = EMPTY
    let strokeIndices = EMPTY_IDX
    const alignCode = node.strokeAlign === 'INSIDE' ? 1 : node.strokeAlign === 'OUTSIDE' ? 2 : 0
    if (wantStroke && node.strokeWeight > 0) {
      const weight = alignCode === 0 ? node.strokeWeight : node.strokeWeight * 2
      const hw = weight / 2
      const ix0 = Math.min(hw, w / 2)
      const iy0 = Math.min(hw, h / 2)
      strokePositions = new Float32Array([
        -hw, -hw, w + hw, -hw, w + hw, h + hw, -hw, h + hw, // outer
        ix0, iy0, w - ix0, iy0, w - ix0, h - iy0, ix0, h - iy0, // inner
      ])
      strokeIndices = new Uint32Array([
        0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
      ])
    }
    return { fillPositions, fillIndices, strokePositions, strokeIndices, strokeAlignCode: alignCode }
  }

  private build(
    scene: SceneGraph,
    node: SceneNode,
    bucket: number,
    wantFill: boolean,
    wantStroke: boolean,
  ): NodeMesh {
    const fast = MeshCache.sharpRect(node, wantStroke)
    if (fast) return fast
    let subpaths: SubPath[]
    let evenOdd = false
    if (node.type === 'BOOLEAN') {
      const rings = booleanRings(scene, node)
      subpaths = rings
        .filter((r: Vec2[]) => r.length >= 3)
        .map((ring: Vec2[]) => ({
          closed: true,
          anchors: ring.map((p) => ({ p, cpIn: null, cpOut: null })),
        }))
      evenOdd = true
    } else {
      subpaths = nodeOutline(node)
      evenOdd = node.type === 'VECTOR' && node.windingRule === 'EVENODD'
    }
    if (subpaths.length === 0) {
      return {
        fillPositions: EMPTY,
        fillIndices: EMPTY_IDX,
        strokePositions: EMPTY,
        strokeIndices: EMPTY_IDX,
        strokeAlignCode: 0,
      }
    }
    const hasClosed = subpaths.some((sp) => sp.closed)
    // Open geometry always strokes CENTER (canvas2d strokePath rule).
    const alignCode = !hasClosed
      ? 0
      : node.strokeAlign === 'INSIDE'
        ? 1
        : node.strokeAlign === 'OUTSIDE'
          ? 2
          : 0
    const tolerance = 0.25 / bucket
    const mesh = wasmHandle().tessellateNode(
      encodeSubPaths(subpaths),
      evenOdd,
      node.strokeWeight,
      alignCode,
      new Float64Array(node.strokeDash),
      tolerance,
      wantFill,
      wantStroke,
    )
    const strokePositions = mesh.strokePositions()
    // Alignment on an open path moves the band off the path; the tessellator centres
    // it, so shift the result. Local space, same units and same function Canvas2D and
    // the gradient box use, so all three land in the same place.
    const offset = openStrokeOffset(node)
    if (offset !== 0) {
      for (let i = 1; i < strokePositions.length; i += 2) strokePositions[i] += offset
    }
    const out: NodeMesh = {
      fillPositions: mesh.fillPositions(),
      fillIndices: mesh.fillIndices(),
      strokePositions,
      strokeIndices: mesh.strokeIndices(),
      strokeAlignCode: alignCode,
    }
    mesh.free()
    return out
  }
}
