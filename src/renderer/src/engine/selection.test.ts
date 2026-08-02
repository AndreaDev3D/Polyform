// Click-resolution semantics (F-19 follow-up). Frames and components are
// containers, not selection units: their contents are clicked directly.
// Groups, booleans and instances are atomic — you double-click to drill in.

import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import { resolveClickTarget } from './hit-test'
import { createNode } from './types'
import type { NodeId, SceneNode } from './types'

function build(): { scene: SceneGraph; id: (name: string) => NodeId } {
  const scene = new SceneGraph()
  const named = new Map<string, NodeId>()
  const add = (type: SceneNode['type'], name: string, parent: NodeId | null): NodeId => {
    const node = createNode(type, name)
    scene.addNode(node, parent, scene.childListOf(parent).length)
    named.set(name, node.id)
    return node.id
  }

  const frame = add('FRAME', 'frame', null)
  add('RECTANGLE', 'inFrame', frame)
  const innerFrame = add('FRAME', 'innerFrame', frame)
  add('RECTANGLE', 'inInnerFrame', innerFrame)

  const group = add('GROUP', 'group', null)
  add('RECTANGLE', 'inGroup', group)
  const nestedGroup = add('GROUP', 'nestedGroup', group)
  add('RECTANGLE', 'inNestedGroup', nestedGroup)

  const groupInFrame = add('GROUP', 'groupInFrame', frame)
  add('RECTANGLE', 'inGroupInFrame', groupInFrame)

  const instance = add('INSTANCE', 'instance', null)
  add('RECTANGLE', 'inInstance', instance)

  return { scene, id: (name) => named.get(name)! }
}

describe('resolveClickTarget', () => {
  const { scene, id } = build()
  const click = (name: string, container: string | null = null) =>
    scene.getNode(resolveClickTarget(scene, id(name), container ? id(container) : null))?.name

  it('selects a frame child directly instead of the frame', () => {
    expect(click('inFrame')).toBe('inFrame')
  })

  it('reaches through nested frames', () => {
    expect(click('inInnerFrame')).toBe('inInnerFrame')
  })

  it('selects the outermost group, not its contents', () => {
    expect(click('inGroup')).toBe('group')
    expect(click('inNestedGroup')).toBe('group')
  })

  it('selects a group inside a frame as a unit', () => {
    expect(click('inGroupInFrame')).toBe('groupInFrame')
  })

  it('keeps instances atomic', () => {
    expect(click('inInstance')).toBe('instance')
  })

  it('clicking a container itself selects it', () => {
    expect(click('frame')).toBe('frame')
    expect(click('group')).toBe('group')
  })

  it('narrows to the direct child once drilled into a container', () => {
    expect(click('inNestedGroup', 'group')).toBe('nestedGroup')
    expect(click('inNestedGroup', 'nestedGroup')).toBe('inNestedGroup')
    expect(click('inFrame', 'frame')).toBe('inFrame')
  })

  it('stops at the page: root nodes are their own click target', () => {
    // Root nodes report the PAGE as their parent (ADR-011), which is not a
    // scene node — the ancestor walk must terminate there rather than
    // returning a page id.
    const page = scene.parentOf(id('frame'))
    expect(page).not.toBeNull()
    expect(scene.getNode(page!)).toBeUndefined()
    expect(click('frame')).toBe('frame')
    expect(click('inFrame')).toBe('inFrame')
  })
})
