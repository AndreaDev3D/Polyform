// v0.6 spike 7.1: the renderer half of the agent bridge (ADR-021).
//
// The MCP server runs in the main process, but the document lives here.
// Main forwards each tool call as a `mcp:sceneRequest`; this module answers
// it from the live DocumentStore and replies. Read-only for the spike —
// the journaled write surface is roadmap item 7.3.

import { documentStore } from '../state/document'
import { editor } from '../state/editor'
import type { NodeId, SceneNode } from '../engine/types'

/** A node as an agent sees it: identity, geometry, and structure only. */
function describe(id: NodeId, depth: number): unknown {
  const scene = documentStore.scene
  const node = scene.getNode(id)
  if (!node) return null
  const out: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    name: node.name,
    x: round(node.x),
    y: round(node.y),
    width: round(node.width),
    height: round(node.height),
  }
  if (!node.visible) out.visible = false
  if (node.locked) out.locked = true
  if (node.rotation !== 0) out.rotation = round(node.rotation)
  if (node.type === 'TEXT') out.characters = node.characters
  if (node.type === 'MODEL3D') out.format = node.format
  const children = childrenOf(node)
  if (children.length > 0) {
    out.childCount = children.length
    // Bound the payload: agents ask for a subtree when they need one.
    if (depth > 0) out.children = children.map((c) => describe(c, depth - 1))
  }
  return out
}

function childrenOf(node: SceneNode): readonly NodeId[] {
  return 'children' in node ? node.children : []
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}

const HANDLERS: Record<string, (params: Record<string, unknown>) => unknown> = {
  'document.summary': () => {
    const scene = documentStore.scene
    const doc = scene.doc
    return {
      project: documentStore.projectInfo?.manifest.title ?? null,
      path: documentStore.projectInfo?.path ?? null,
      schemaVersion: doc.schemaVersion,
      nodeCount: Object.keys(doc.nodes).length,
      pages: doc.pages.map((p) => ({ id: p.id, name: p.name, rootCount: p.rootIds.length })),
      activePageId: doc.activePageId,
      // Two levels is enough to orient without dumping a 100k-node scene.
      tree: scene.rootIds().map((id) => describe(id, 2)),
    }
  },

  'selection.get': () => {
    const ids = editor.get().selection
    return { count: ids.length, nodes: ids.map((id) => describe(id, 1)).filter(Boolean) }
  },

  'changes.since': (params) => {
    const cursor = Math.max(0, Number(params.cursor) || 0)
    const stack = documentStore.history.entriesApplied()
    const entries = stack.slice(cursor).map((entry, i) => ({
      index: cursor + i,
      label: entry.label,
      // Which nodes the edit touched — enough for an agent to know where
      // to look without replaying op payloads.
      nodeIds: [...new Set(entry.ops.map((op) => ('id' in op ? op.id : op.kind === 'add' ? op.node.id : null)).filter(Boolean))],
    }))
    return { cursor: stack.length, newEntries: entries.length, entries }
  },
}

let installed = false

/** Wire the renderer to the main-process MCP server. Safe to call twice. */
export function installAgentBridge(): void {
  if (installed) return
  installed = true
  window.polyform.onMcpSceneRequest((id, method, params) => {
    try {
      const handler = HANDLERS[method]
      if (!handler) throw new Error(`unknown scene method: ${method}`)
      window.polyform.mcpSceneReply(id, true, handler((params ?? {}) as Record<string, unknown>))
    } catch (err) {
      window.polyform.mcpSceneReply(id, false, err instanceof Error ? err.message : String(err))
    }
  })
}
