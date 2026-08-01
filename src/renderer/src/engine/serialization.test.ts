import { describe, expect, it } from 'vitest'
import { SceneGraph } from './scene'
import { decodeScene, encodeScene, SceneDecodeError } from './serialization'
import { createNode } from './types'
import type { FrameNode, TextNode, VectorNode } from './types'

describe('scene.bin serialization', () => {
  it('round-trips a document with nested nodes and vector networks', () => {
    const scene = new SceneGraph()
    const frame = createNode('FRAME', 'Frame') as FrameNode
    frame.layout.mode = 'VERTICAL'
    frame.cornerRadius = { tl: 4, tr: 4, br: 8, bl: 8 }
    scene.addNode(frame, null, 0)

    const text = createNode('TEXT', 'Hello') as TextNode
    text.characters = 'Hello\nPolyform'
    text.fontFamily = 'Segoe UI'
    scene.addNode(text, frame.id, 0)

    const vec = createNode('VECTOR', 'Path') as VectorNode
    vec.network = {
      vertices: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 50, y: 10 },
      ],
      edges: [{ id: 0, v0: 0, v1: 1, cp0: { x: 10, y: -20 }, cp1: null }],
    }
    scene.addNode(vec, null, 1)

    const bytes = encodeScene(scene.doc)
    expect(bytes[0]).toBe(0x50) // 'P'
    const decoded = decodeScene(bytes)
    expect(decoded.pages[0].rootIds).toEqual(scene.rootIds())
    expect(Object.keys(decoded.nodes)).toHaveLength(3)
    const decodedText = decoded.nodes[text.id] as TextNode
    expect(decodedText.characters).toBe('Hello\nPolyform')
    const decodedVec = decoded.nodes[vec.id] as VectorNode
    expect(decodedVec.network.edges[0].cp0).toEqual({ x: 10, y: -20 })
  })

  it('rejects malformed input', () => {
    expect(() => decodeScene(new Uint8Array([1, 2, 3]))).toThrow(SceneDecodeError)
    expect(() => decodeScene(new TextEncoder().encode('NOTAPOLYFILE'))).toThrow(SceneDecodeError)
  })
})
