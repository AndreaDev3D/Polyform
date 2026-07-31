import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import { runDerivedPasses } from './layout'
import { createNode } from './types'
import type { FrameNode, GroupNode } from './types'

function frameWithChildren(mode: 'HORIZONTAL' | 'VERTICAL'): { scene: SceneGraph; frame: FrameNode; a: string; b: string } {
  const scene = new SceneGraph()
  const frame = createNode('FRAME', 'F') as FrameNode
  frame.width = 300
  frame.height = 200
  frame.layout = { ...frame.layout, mode, gap: 10, paddingTop: 5, paddingLeft: 5, paddingRight: 5, paddingBottom: 5 }
  scene.addNode(frame, null, 0)
  const a = createNode('RECTANGLE', 'A')
  a.width = 50
  a.height = 40
  scene.addNode(a, frame.id, 0)
  const b = createNode('RECTANGLE', 'B')
  b.width = 30
  b.height = 60
  scene.addNode(b, frame.id, 1)
  return { scene, frame, a: a.id, b: b.id }
}

describe('auto layout', () => {
  it('stacks children horizontally with gap and padding', () => {
    const { scene, a, b } = frameWithChildren('HORIZONTAL')
    runDerivedPasses(scene)
    const na = scene.requireNode(a)
    const nb = scene.requireNode(b)
    expect(na.x).toBe(5)
    expect(nb.x).toBe(5 + 50 + 10)
    expect(na.y).toBe(5)
  })

  it('hug sizing shrinks the frame to content', () => {
    const { scene, frame } = frameWithChildren('VERTICAL')
    frame.layout.primarySizing = 'HUG'
    frame.layout.counterSizing = 'HUG'
    runDerivedPasses(scene)
    expect(frame.height).toBeCloseTo(5 + 40 + 10 + 60 + 5)
    expect(frame.width).toBeCloseTo(5 + 50 + 5)
  })

  it('normalizes group bounds around children', () => {
    const scene = new SceneGraph()
    const group = createNode('GROUP', 'G') as GroupNode
    group.x = 0
    group.y = 0
    group.width = 10
    group.height = 10
    scene.addNode(group, null, 0)
    const rect = createNode('RECTANGLE', 'R')
    rect.x = 40
    rect.y = 30
    rect.width = 20
    rect.height = 20
    scene.addNode(rect, group.id, 0)
    runDerivedPasses(scene)
    expect(group.x).toBe(40)
    expect(group.y).toBe(30)
    expect(group.width).toBe(20)
    expect(group.height).toBe(20)
    expect(scene.requireNode(rect.id).x).toBe(0)
  })

  it('text auto-resize adjusts height', () => {
    const scene = new SceneGraph()
    const text = createNode('TEXT', 'T')
    if (text.type === 'TEXT') {
      text.characters = 'line1\nline2\nline3'
      text.autoResize = 'HEIGHT'
      text.width = 200
      text.height = 10
    }
    scene.addNode(text, null, 0)
    runDerivedPasses(scene)
    const n = scene.requireNode(text.id)
    expect(n.height).toBeCloseTo(3 * 16 * 1.2)
  })
})
