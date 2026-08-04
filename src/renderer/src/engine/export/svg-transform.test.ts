// The SVG exporter is the one consumer that does NOT go through
// scene.localMatrix — it writes a `transform` attribute by hand, because SVG
// wants a transform list rather than a matrix. So it can silently disagree with
// the canvas about where a node is.
//
// This test parses what the exporter emits and composes it back into a matrix,
// then compares that against nodeLocalMatrix. Not a string snapshot: the point
// is equivalence, and there are several correct ways to spell the same
// transform.

import { describe, expect, it } from 'vitest'
import { transformAttrFor } from './svg'
import { createNode } from '../types'
import type { SceneNode } from '../types'
import {
  IDENTITY,
  applyMat,
  matMultiply,
  matRotateDeg,
  matScale,
  matTranslate,
  nodeLocalMatrix,
  type Mat,
} from '../geometry'

/** Compose an SVG transform list the way a renderer would: left to right. */
function parseTransform(attr: string): Mat {
  const inner = attr.match(/transform="([^"]*)"/)?.[1]
  if (!inner) return IDENTITY
  let m = IDENTITY
  const re = /(translate|rotate|scale)\(([^)]*)\)/g
  for (let hit = re.exec(inner); hit; hit = re.exec(inner)) {
    const [, op] = hit
    const args = hit[2].trim().split(/[\s,]+/).map(Number)
    let step: Mat
    if (op === 'translate') step = matTranslate(args[0], args[1] ?? 0)
    else if (op === 'scale') step = matScale(args[0], args[1] ?? args[0])
    else if (args.length === 3) {
      // rotate(a cx cy) === translate(cx cy) rotate(a) translate(-cx -cy)
      step = matMultiply(
        matTranslate(args[1], args[2]),
        matMultiply(matRotateDeg(args[0]), matTranslate(-args[1], -args[2])),
      )
    } else step = matRotateDeg(args[0])
    m = matMultiply(m, step)
  }
  return m
}

function node(props: Partial<SceneNode>): SceneNode {
  const n = createNode('RECTANGLE', 'r')
  Object.assign(n, { x: 17, y: -23, width: 140, height: 60, rotation: 0 }, props)
  return n
}

describe('SVG transform matches the engine matrix', () => {
  const cases: { label: string; props: Partial<SceneNode> }[] = [
    { label: 'plain', props: {} },
    { label: 'at the origin', props: { x: 0, y: 0 } },
    { label: 'rotated', props: { rotation: 37 } },
    { label: 'flipped H', props: { flipH: true } },
    { label: 'flipped V', props: { flipV: true } },
    { label: 'flipped both', props: { flipH: true, flipV: true } },
    { label: 'rotated and flipped H', props: { rotation: 37, flipH: true } },
    { label: 'rotated and flipped both', props: { rotation: -104, flipH: true, flipV: true } },
    { label: 'flipped, square', props: { width: 80, height: 80, rotation: 90, flipV: true } },
  ]

  for (const { label, props } of cases) {
    it(label, () => {
      const n = node(props)
      const fromSvg = parseTransform(transformAttrFor(n))
      const fromEngine = nodeLocalMatrix(n.x, n.y, n.width, n.height, n.rotation, n.flipH ?? false, n.flipV ?? false)
      // Compare where the corners land — that is what a reader of either output
      // actually sees, and it does not care how the matrix was spelled.
      for (const p of [
        { x: 0, y: 0 },
        { x: n.width, y: 0 },
        { x: n.width, y: n.height },
        { x: 0, y: n.height },
      ]) {
        const a = applyMat(fromSvg, p)
        const b = applyMat(fromEngine, p)
        expect(a.x, `${label} x`).toBeCloseTo(b.x, 6)
        expect(a.y, `${label} y`).toBeCloseTo(b.y, 6)
      }
    })
  }

  it('emits nothing at all for an untransformed node at the origin', () => {
    expect(transformAttrFor(node({ x: 0, y: 0 }))).toBe('')
  })
})
