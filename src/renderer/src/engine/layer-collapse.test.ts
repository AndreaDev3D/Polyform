// Folding the layer tree.
//
// The panel renders whatever set these return, so the set IS the behaviour: a
// row is in the list if none of its ancestors is in here. Every case below is
// stated as which ids are folded, because that pair of facts — what is in the
// set, and what a row's ancestors are — fully determines what you see.

import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import { createNode } from './types'
import type { FrameNode, GroupNode } from './types'
import { collapseAll, expandSelected } from './layer-collapse'

/**
 * Outer frame → inner group → leaf, plus a sibling rect at root. Three levels,
 * which is the fewest that can tell "expand the node" apart from "expand the
 * path down to it".
 */
function fixture() {
  const scene = new SceneGraph()
  const outer = createNode('FRAME', 'Outer') as FrameNode
  const sibling = createNode('RECTANGLE', 'Sibling')
  scene.addNode(outer, null, 0)
  scene.addNode(sibling, null, 1)
  const inner = createNode('GROUP', 'Inner') as GroupNode
  scene.addNode(inner, outer.id, 0)
  const leaf = createNode('RECTANGLE', 'Leaf')
  scene.addNode(leaf, inner.id, 0)
  return { scene, outer, inner, leaf, sibling }
}

describe('layer tree collapse', () => {
  it('folds every container and nothing else', () => {
    const { scene, outer, inner, leaf, sibling } = fixture()
    const set = collapseAll(scene)
    // Nested containers too — collapsing only the top level would leave the
    // tree looking folded and spring back open the moment you opened one.
    expect(set).toEqual(new Set([outer.id, inner.id]))
    // Leaves have no caret, so putting them in the set would be a lie the panel
    // has no way to show.
    expect(set.has(leaf.id)).toBe(false)
    expect(set.has(sibling.id)).toBe(false)
  })

  it('opens the path down to the selection, not just the selection', () => {
    const { scene, outer, inner, leaf } = fixture()
    // The case the command exists for: everything shut, one thing selected on
    // the canvas. Opening `inner` alone would leave its row ABSENT from the
    // list — the ancestors have to go too or nothing appears to happen.
    const next = expandSelected(scene, collapseAll(scene), [inner.id])
    expect(next.has(outer.id)).toBe(false)
    expect(next.has(inner.id)).toBe(false)
    expect(next.has(leaf.id)).toBe(false)
  })

  it('opens the whole subtree of what is selected', () => {
    const { scene, outer, inner } = fixture()
    // "Expand this" means "show me what is in it". One level at a time is the
    // clicking this replaces.
    const next = expandSelected(scene, collapseAll(scene), [outer.id])
    expect(next.has(inner.id)).toBe(false)
    expect(next).toEqual(new Set())
  })

  it('leaves other branches folded', () => {
    const scene = new SceneGraph()
    const a = createNode('FRAME', 'A') as FrameNode
    const b = createNode('FRAME', 'B') as FrameNode
    scene.addNode(a, null, 0)
    scene.addNode(b, null, 1)
    scene.addNode(createNode('RECTANGLE', 'inA'), a.id, 0)
    scene.addNode(createNode('RECTANGLE', 'inB'), b.id, 0)
    // Expanding is not "expand everything except": B is untouched, so a tree
    // brought under control stays under control.
    expect(expandSelected(scene, collapseAll(scene), [a.id])).toEqual(new Set([b.id]))
  })

  it('keeps earlier expansions when a second layer is expanded', () => {
    const { scene, outer, sibling } = fixture()
    const once = expandSelected(scene, collapseAll(scene), [outer.id])
    // Nothing is folded shut here — only opened. Expanding one layer after
    // another must not undo the first, or the command would only ever show one
    // branch at a time.
    expect(expandSelected(scene, once, [sibling.id])).toEqual(once)
  })

  it('reveals a selected leaf, which has nothing of its own to open', () => {
    const { scene, leaf } = fixture()
    // Still worth doing: the ancestors are what was hiding it.
    expect(expandSelected(scene, collapseAll(scene), [leaf.id])).toEqual(new Set())
  })

  it('ignores ids that are no longer in the document', () => {
    const { scene } = fixture()
    const before = collapseAll(scene)
    // A stale selection outlives the node it names — deleting a layer and then
    // expanding must not throw.
    expect(expandSelected(scene, before, ['gone'])).toEqual(before)
  })
})
