// Figma's flattened path geometry, and the reason `.fig` import can be faithful
// without reverse-engineering their editable vector network.
//
// Every shape node in a `.fig` carries `fillGeometry` (and `strokeGeometry`): a
// list of paths, each a winding rule plus an index into the file's `blobs` array.
// The blob is a command stream in NODE-LOCAL coordinates, which is the same space
// our own VectorNetwork uses — so it maps across without a transform.
//
// The stream is `op byte, then N float32`, with no length prefix:
//
//   0x00  CLOSE      0 floats
//   0x01  MOVE_TO    2
//   0x02  LINE_TO    2
//   0x03  QUAD_TO    4   (inferred — see below)
//   0x04  CUBIC_TO   6
//
// Where the arities come from, since guessing them would be the easiest way to
// import silently-wrong shapes:
//   - A 1024×1024 frame's fill is 46 bytes and parses EXACTLY as
//     MOVE(0,0) LINE(1024,0) LINE(1024,1024) LINE(0,1024) LINE(0,0) CLOSE.
//   - Requiring every geometry blob in three real exports to consume exactly its
//     own length leaves only one consistent assignment: 93/93 parse with CUBIC at
//     0x04, and 57 of them fail if 0x04 is not an op at all.
//   - A 64×64 ellipse decodes to MOVE + 4 cubics + CLOSE with control points at
//     49.67 = 32 + 32 × 0.5523 — the circle kappa. Arithmetic that lands on a
//     known constant is not a coincidence.
//   - 0x03 never appears in any of the three files. Four floats is the only arity
//     that fits a quadratic, and it converts to a cubic exactly, so it is
//     supported — but it is INFERRED, and an import that meets one says so.

import type { Vec2, VectorEdge, VectorNetwork, VectorVertex } from '../../types'

export const FIG_PATH_OP = { CLOSE: 0x00, MOVE: 0x01, LINE: 0x02, QUAD: 0x03, CUBIC: 0x04 } as const

const ARITY: Record<number, number> = {
  [FIG_PATH_OP.CLOSE]: 0,
  [FIG_PATH_OP.MOVE]: 2,
  [FIG_PATH_OP.LINE]: 2,
  [FIG_PATH_OP.QUAD]: 4,
  [FIG_PATH_OP.CUBIC]: 6,
}

export interface FigPathCommand {
  op: number
  args: number[]
}

export interface ParsedGeometry {
  commands: FigPathCommand[]
  /** True when a 0x03 (quadratic) was seen: supported, but never observed in a real file. */
  usedInferredOp: boolean
}

/** Decode one geometry blob. Throws rather than guessing — a partial path is a wrong shape. */
export function parsePathCommands(bytes: Uint8Array): ParsedGeometry {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const commands: FigPathCommand[] = []
  let usedInferredOp = false
  let o = 0
  while (o < bytes.length) {
    const op = bytes[o++]
    const n = ARITY[op]
    if (n === undefined) throw new Error(`fig geometry: unknown path op 0x${op.toString(16)} at byte ${o - 1}`)
    if (op === FIG_PATH_OP.QUAD) usedInferredOp = true
    if (o + n * 4 > bytes.length) {
      throw new Error(`fig geometry: op 0x${op.toString(16)} needs ${n * 4} bytes, ${bytes.length - o} remain`)
    }
    const args: number[] = []
    for (let i = 0; i < n; i++) {
      args.push(view.getFloat32(o, true))
      o += 4
    }
    commands.push({ op, args })
  }
  return { commands, usedInferredOp }
}

/**
 * Turn command streams into one of our vector networks.
 *
 * Several paths become several disconnected subpaths in a single network, which
 * is what a graph-shaped model is for — a donut, a boolean result and a glyph all
 * arrive as one node with more than one contour, the same way `flatten` and
 * `carve` produce them here.
 *
 * A quadratic is promoted to a cubic exactly: c1 = p0 + 2/3(q − p0),
 * c2 = p1 + 2/3(q − p1). Not an approximation — the degree elevation of a
 * quadratic Bézier is a cubic with those control points.
 */
export function networkFromPaths(paths: ParsedGeometry[]): VectorNetwork {
  const vertices: VectorVertex[] = []
  const edges: VectorEdge[] = []
  let nextVertex = 1
  let nextEdge = 1

  const addVertex = (x: number, y: number): number => {
    const id = nextVertex++
    vertices.push({ id, x, y })
    return id
  }
  const addEdge = (v0: number, v1: number, cp0: Vec2 | null, cp1: Vec2 | null): void => {
    // A zero-length segment carries no shape and would only confuse the editor.
    if (v0 === v1 && !cp0 && !cp1) return
    edges.push({ id: nextEdge++, v0, v1, cp0, cp1 })
  }

  for (const { commands } of paths) {
    let startVertex: number | null = null
    let currentVertex: number | null = null
    let cx = 0
    let cy = 0
    for (const { op, args } of commands) {
      switch (op) {
        case FIG_PATH_OP.MOVE: {
          ;[cx, cy] = args
          startVertex = addVertex(cx, cy)
          currentVertex = startVertex
          break
        }
        case FIG_PATH_OP.LINE: {
          if (currentVertex === null) break
          const [x, y] = args
          const v = addVertex(x, y)
          addEdge(currentVertex, v, null, null)
          currentVertex = v
          cx = x
          cy = y
          break
        }
        case FIG_PATH_OP.QUAD: {
          if (currentVertex === null) break
          const [qx, qy, x, y] = args
          const v = addVertex(x, y)
          addEdge(
            currentVertex,
            v,
            { x: cx + (2 / 3) * (qx - cx), y: cy + (2 / 3) * (qy - cy) },
            { x: x + (2 / 3) * (qx - x), y: y + (2 / 3) * (qy - y) },
          )
          currentVertex = v
          cx = x
          cy = y
          break
        }
        case FIG_PATH_OP.CUBIC: {
          if (currentVertex === null) break
          const [c1x, c1y, c2x, c2y, x, y] = args
          const v = addVertex(x, y)
          addEdge(currentVertex, v, { x: c1x, y: c1y }, { x: c2x, y: c2y })
          currentVertex = v
          cx = x
          cy = y
          break
        }
        case FIG_PATH_OP.CLOSE: {
          if (currentVertex !== null && startVertex !== null && currentVertex !== startVertex) {
            // Close with a straight run back, unless the stream already walked
            // there — Figma often emits the closing LINE itself, and a duplicate
            // vertex on top of the start point is a visible artefact in the
            // vector editor even though it renders identically.
            const a = vertices.find((p) => p.id === currentVertex)!
            const b = vertices.find((p) => p.id === startVertex)!
            if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) {
              // Fold the duplicate: rewire the last edge onto the start vertex.
              const last = edges[edges.length - 1]
              if (last && last.v1 === currentVertex) {
                last.v1 = startVertex
                vertices.splice(vertices.indexOf(a), 1)
              }
            } else {
              addEdge(currentVertex, startVertex, null, null)
            }
          }
          currentVertex = startVertex
          break
        }
        default:
          break
      }
    }
  }
  return { vertices, edges }
}

/**
 * Figma's rule, in Figma's spelling.
 *
 * Their enum is `NONZERO | ODD` — read out of the schema embedded in a real file,
 * not assumed. This used to compare against `EVENODD`, which is OUR name for that
 * rule and never a value they write, so **every even-odd path in every `.fig` ever
 * imported arrived as nonzero** (F-32): a subtraction's hole filled itself in, and
 * a boolean looked like a blob. `EVENODD` is still accepted so the function reads
 * correctly whichever spelling reaches it.
 */
export function windingRuleFrom(value: unknown): 'NONZERO' | 'EVENODD' {
  const rule = String(value ?? 'NONZERO').toUpperCase()
  return rule === 'ODD' || rule === 'EVENODD' ? 'EVENODD' : 'NONZERO'
}
