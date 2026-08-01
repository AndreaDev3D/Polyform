// v0.3 component/instance engine tests.

import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import { runDerivedPasses } from './layout'
import { collectGarbage, instanceSyncHash, syncInstances } from './components'
import { createNode } from './types'
import type { ComponentNode, InstanceNode, RectangleNode } from './types'

function setup(): { scene: SceneGraph; comp: ComponentNode; rect: RectangleNode; inst: InstanceNode } {
  const scene = new SceneGraph()
  const comp = createNode('COMPONENT', 'Button') as ComponentNode
  comp.x = 0
  comp.y = 0
  comp.width = 200
  comp.height = 50
  scene.addNode(comp, null, 0)
  const rect = createNode('RECTANGLE', 'Bg') as RectangleNode
  rect.width = 200
  rect.height = 50
  rect.constraintsH = 'STRETCH'
  scene.addNode(rect, comp.id, 0)
  const inst = createNode('INSTANCE', 'Button') as InstanceNode
  inst.componentId = comp.id
  inst.x = 400
  inst.width = 200
  inst.height = 50
  scene.addNode(inst, null, 1)
  runDerivedPasses(scene)
  return { scene, comp, rect, inst }
}

describe('instance materialization', () => {
  it('copies the component subtree with sourceIds', () => {
    const { scene, rect, inst } = setup()
    expect(inst.children).toHaveLength(1)
    const copy = scene.requireNode(inst.children[0])
    expect(copy.type).toBe('RECTANGLE')
    expect(copy.sourceId).toBe(rect.id)
    expect(copy.id).not.toBe(rect.id)
    expect(copy.width).toBe(200)
  })

  it('component edits propagate; materialized ids stay stable', () => {
    const { scene, rect, inst } = setup()
    const firstCopyId = inst.children[0]
    scene.updateNode(rect.id, { fills: [{ type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 0, b: 0, a: 1 } }] })
    runDerivedPasses(scene)
    expect(inst.children[0]).toBe(firstCopyId)
    const copy = scene.requireNode(inst.children[0])
    expect(copy.fills[0]).toMatchObject({ color: { r: 1, g: 0, b: 0, a: 1 } })
  })

  it('overrides survive component re-sync', () => {
    const { scene, rect, inst } = setup()
    inst.overrides = { [rect.id]: { opacity: 0.5 } }
    inst.syncedHash = ''
    runDerivedPasses(scene)
    expect(scene.requireNode(inst.children[0]).opacity).toBe(0.5)
    // Component change re-materializes; the override persists.
    scene.updateNode(rect.id, { name: 'Bg2' })
    runDerivedPasses(scene)
    const copy = scene.requireNode(inst.children[0])
    expect(copy.name).toBe('Bg2')
    expect(copy.opacity).toBe(0.5)
  })

  it('instance size applies constraints against component size', () => {
    const { scene, inst } = setup()
    inst.width = 300
    inst.syncedHash = ''
    runDerivedPasses(scene)
    const copy = scene.requireNode(inst.children[0])
    expect(copy.width).toBe(300) // STRETCH follows both edges
  })

  it('sync hash is stable when nothing changed', () => {
    const { scene, comp, inst } = setup()
    const h1 = instanceSyncHash(scene, inst, comp)
    const h2 = instanceSyncHash(scene, inst, comp)
    expect(h1).toBe(h2)
    expect(syncInstances(scene)).toBe(false)
  })

  it('garbage collection removes orphaned materialized nodes', () => {
    const { scene, inst } = setup()
    const copyId = inst.children[0]
    // Simulate an undo of the instance-add op: node removed, children orphaned.
    scene.removeNode(inst.id)
    expect(scene.doc.nodes[copyId]).toBeDefined()
    collectGarbage(scene)
    expect(scene.doc.nodes[copyId]).toBeUndefined()
  })

  it('self-referential instances refuse to expand', () => {
    const scene = new SceneGraph()
    const comp = createNode('COMPONENT', 'Recursive') as ComponentNode
    scene.addNode(comp, null, 0)
    const inner = createNode('INSTANCE', 'inner') as InstanceNode
    inner.componentId = comp.id
    scene.addNode(inner, comp.id, 0)
    // Must terminate (cycle guard) rather than expanding forever.
    runDerivedPasses(scene)
    expect(scene.requireNode(inner.id).type).toBe('INSTANCE')
    expect((scene.requireNode(inner.id) as InstanceNode).children).toHaveLength(0)
  })
})
