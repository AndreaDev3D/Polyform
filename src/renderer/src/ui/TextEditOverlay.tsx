// On-canvas text editing via a transformed DOM textarea positioned exactly
// over the text node (the canvas skips drawing that node while editing).

import { useEffect, useMemo, useRef } from 'react'
import type { NodeId, TextNode } from '../engine/types'
import { matMultiply } from '../engine/geometry'
import { documentStore, useDocVersion } from '../state/document'
import { useEditor } from '../state/editor'
import { rgbaToCss } from '../engine/color'
import { removeSubtreeOps } from '../engine/commands'

export function TextEditOverlay({ nodeId }: { nodeId: NodeId }) {
  useDocVersion()
  const camera = useEditor((s) => s.camera)
  const setEditingTextId = useEditor((s) => s.setEditingTextId)
  const ref = useRef<HTMLTextAreaElement>(null)
  const initialRef = useRef<string | null>(null)
  const committedRef = useRef(false)

  const node = documentStore.scene.getNode(nodeId) as TextNode | undefined

  useEffect(() => {
    // Re-arm on every (re)mount so a remounted overlay can still commit.
    committedRef.current = false
    if (node && initialRef.current === null) {
      initialRef.current = node.characters
    }
    const el = ref.current
    if (el) {
      el.focus()
      el.select()
    }
    // Commit on unmount if not already done (blur does not fire when the
    // element is removed from the DOM, e.g. Escape via the controller).
    return () => {
      if (!committedRef.current) commit()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const transform = useMemo(() => {
    if (!node) return ''
    const m = documentStore.scene.worldMatrix(nodeId)
    const cam = { a: camera.zoom, b: 0, c: 0, d: camera.zoom, e: -camera.x * camera.zoom, f: -camera.y * camera.zoom }
    const t = matMultiply(cam, m)
    return `matrix(${t.a}, ${t.b}, ${t.c}, ${t.d}, ${t.e}, ${t.f})`
  }, [node, nodeId, camera])

  if (!node) return null

  const commit = () => {
    if (committedRef.current) return
    committedRef.current = true
    const scene = documentStore.scene
    const live = scene.getNode(nodeId) as TextNode | undefined
    const before = initialRef.current ?? ''
    if (!live) return
    if (live.characters.trim() === '') {
      // Empty text: remove the node entirely (including its own add if new).
      const ops = removeSubtreeOps(scene, nodeId)
      for (const op of ops) if (op.kind === 'remove') scene.removeNode(op.node.id)
      documentStore.commit(ops, 'Remove Empty Text', true)
      useEditor.getState().setSelection([])
    } else if (live.characters !== before) {
      documentStore.commit(
        [{ kind: 'update', id: nodeId, before: { characters: before }, after: { characters: live.characters } }],
        'Edit Text',
        true,
      )
    }
    setEditingTextId(null)
  }

  const fill = node.fills.find((f) => f.visible)
  const color = fill && fill.type === 'SOLID' ? rgbaToCss(fill.color) : '#000'

  return (
    <textarea
      ref={ref}
      value={node.characters}
      spellCheck={false}
      onChange={(e) => {
        documentStore.scene.updateNode(nodeId, { characters: e.target.value })
        documentStore.transient()
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault()
          commit()
        }
      }}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transformOrigin: '0 0',
        transform,
        width: Math.max(node.width + 4, 24),
        height: Math.max(node.height + 4, node.fontSize * node.lineHeight),
        fontFamily: `"${node.fontFamily}", sans-serif`,
        fontSize: node.fontSize,
        fontWeight: node.fontWeight,
        fontStyle: node.italic ? 'italic' : 'normal',
        lineHeight: node.lineHeight,
        letterSpacing: node.letterSpacing,
        textAlign: node.textAlignH.toLowerCase() as 'left' | 'center' | 'right',
        color,
        caretColor: '#4f9eff',
        background: 'transparent',
        border: '1px solid rgba(79,158,255,0.6)',
        outline: 'none',
        resize: 'none',
        overflow: 'hidden',
        padding: 0,
        margin: 0,
        whiteSpace: node.autoResize === 'WIDTH_AND_HEIGHT' ? 'pre' : 'pre-wrap',
      }}
    />
  )
}
