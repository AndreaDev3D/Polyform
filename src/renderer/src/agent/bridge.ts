// v0.6 items 7.1/7.2: the renderer half of the agent bridge (ADR-021).
//
// The MCP server runs in the main process, but the document lives here.
// Main forwards each tool call as a `mcp:sceneRequest`; this module answers
// it from the live DocumentStore and replies. Read-only — the journaled
// write surface is roadmap item 7.3.
//
// Payload discipline: an agent's tool-result budget is small (Claude Code
// truncates around 25k tokens), and a Polyform document can hold 100k
// nodes. So the summary stays shallow and every response that could run
// away carries an explicit, REPORTED cap — a silently truncated tree reads
// as a complete one, which is worse than no answer.

import { agentApi } from './control'
import { nodeSnapshot, viewportSnapshot } from './snapshot'
import { documentStore } from '../state/document'
import { editor } from '../state/editor'
import { rgbaToHex } from '../engine/color'
import type {
  AutoLayout,
  Effect,
  NodeId,
  Paint,
  SceneNode,
  StyleRefs,
} from '../engine/types'

/** Hard ceiling on nodes emitted by one detail call. */
const MAX_DETAIL_NODES = 400
/** Hard ceiling on depth, whatever the caller asks for. */
const MAX_DEPTH = 8

function round(v: number): number {
  return Math.round(v * 100) / 100
}

function color(c: { r: number; g: number; b: number; a: number }): string {
  // #RRGGBB when opaque, otherwise #RRGGBB @ alpha — agents read hex fluently.
  return c.a >= 1 ? `#${rgbaToHex(c)}` : `#${rgbaToHex(c)} @${round(c.a)}`
}

function paint(p: Paint): unknown {
  const base: Record<string, unknown> = { type: p.type }
  if (!p.visible) base.visible = false
  if (p.opacity !== 1) base.opacity = round(p.opacity)
  if (p.type === 'SOLID') base.color = color(p.color)
  else if (p.type === 'IMAGE') {
    base.assetHash = p.assetHash
    base.scaleMode = p.scaleMode
    if (p.crop) base.cropped = true
    if (p.originalAssetHash) base.backgroundRemoved = true
  } else {
    base.stops = p.stops.map((s) => ({ at: round(s.position), color: color(s.color) }))
  }
  return base
}

function effect(e: Effect): unknown {
  const base: Record<string, unknown> = { type: e.type }
  if (!e.visible) base.visible = false
  if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
    base.color = color(e.color)
    base.offset = { x: round(e.offset.x), y: round(e.offset.y) }
    base.blur = round(e.blur)
  } else {
    base.radius = round(e.radius)
  }
  return base
}

function layout(l: AutoLayout): unknown | null {
  if (l.mode === 'NONE') return null
  return {
    direction: l.mode,
    gap: l.gap,
    padding: [l.paddingTop, l.paddingRight, l.paddingBottom, l.paddingLeft],
    align: l.counterAlign,
    sizing: { primary: l.primarySizing, counter: l.counterSizing },
  }
}

/** Resolve style references to names — an id tells an agent nothing. */
function styleRefs(refs: StyleRefs | undefined): unknown | null {
  if (!refs) return null
  const { colors, texts, effects } = documentStore.scene.doc.styles
  const out: Record<string, string> = {}
  const fill = refs.fill && colors.find((s) => s.id === refs.fill)
  const text = refs.text && texts.find((s) => s.id === refs.text)
  const fx = refs.effect && effects.find((s) => s.id === refs.effect)
  if (fill) out.fill = fill.name
  if (text) out.text = text.name
  if (fx) out.effect = fx.name
  return Object.keys(out).length > 0 ? out : null
}

function childrenOf(node: SceneNode): readonly NodeId[] {
  return 'children' in node ? node.children : []
}

/** One-word appearance hint for the shallow tree — cheap, and often enough. */
function fillHint(node: SceneNode): string | undefined {
  const visible = node.fills.find((f) => f.visible)
  if (!visible) return undefined
  if (visible.type === 'SOLID') return color(visible.color)
  return visible.type === 'IMAGE' ? 'image' : 'gradient'
}

/** A node as an agent sees it in the TREE: identity, geometry, structure. */
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
  const fill = fillHint(node)
  if (fill) out.fill = fill
  if (node.type === 'TEXT') out.characters = node.characters
  if (node.type === 'MODEL3D') out.format = node.format
  if (node.type === 'INSTANCE') {
    out.componentName = scene.getNode(node.componentId)?.name ?? '(missing)'
  }
  const children = childrenOf(node)
  if (children.length > 0) {
    out.childCount = children.length
    // Bound the payload: agents call get_node for a subtree when they need
    // one, rather than every call carrying the whole document.
    if (depth > 0) out.children = children.map((c) => describe(c, depth - 1))
  }
  return out
}

/** A node in FULL: everything that decides how it looks. */
function detail(id: NodeId, depth: number, budget: { left: number }): unknown {
  const scene = documentStore.scene
  const node = scene.getNode(id)
  if (!node) return null
  budget.left -= 1

  const out: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    name: node.name,
    x: round(node.x),
    y: round(node.y),
    width: round(node.width),
    height: round(node.height),
  }
  if (node.rotation !== 0) out.rotation = round(node.rotation)
  if (!node.visible) out.visible = false
  if (node.locked) out.locked = true
  if (node.opacity !== 1) out.opacity = round(node.opacity)
  if (node.blendMode !== 'NORMAL') out.blendMode = node.blendMode
  if (node.isMask) out.isMask = true

  if (node.fills.length > 0) out.fills = node.fills.map(paint)
  if (node.strokes.length > 0) {
    out.strokes = node.strokes.map(paint)
    out.strokeWeight = round(node.strokeWeight)
    out.strokeAlign = node.strokeAlign
    if (node.strokeDash.length > 0) out.strokeDash = node.strokeDash
  }
  if (node.effects.length > 0) out.effects = node.effects.map(effect)

  const refs = styleRefs(node.styleRefs)
  if (refs) out.styles = refs
  if (node.constraintsH || node.constraintsV) {
    out.constraints = { h: node.constraintsH ?? 'MIN', v: node.constraintsV ?? 'MIN' }
  }

  if ('cornerRadius' in node) {
    const r = node.cornerRadius
    const uniform = r.tl === r.tr && r.tr === r.br && r.br === r.bl
    if (!uniform || r.tl !== 0) out.cornerRadius = uniform ? r.tl : [r.tl, r.tr, r.br, r.bl]
  }
  if ('clipsContent' in node) out.clipsContent = node.clipsContent
  if ('layout' in node) {
    const l = layout(node.layout)
    if (l) out.autoLayout = l
  }

  if (node.type === 'TEXT') {
    out.characters = node.characters
    out.font = {
      family: node.fontFamily,
      weight: node.fontWeight,
      size: round(node.fontSize),
      lineHeight: round(node.lineHeight),
      letterSpacing: round(node.letterSpacing),
      ...(node.italic ? { italic: true } : {}),
    }
    out.textAlign = { h: node.textAlignH, v: node.textAlignV }
    out.autoResize = node.autoResize
  }

  if (node.type === 'MODEL3D') {
    out.format = node.format
    out.assetHash = node.assetHash
    out.camera = node.camera
    out.lighting = node.lighting
  }

  if (node.type === 'INSTANCE') {
    const main = scene.getNode(node.componentId)
    out.component = {
      id: node.componentId,
      name: main?.name ?? '(missing)',
      overriddenNodes: Object.keys(node.overrides).length,
      overriddenProps: [
        ...new Set(Object.values(node.overrides).flatMap((o) => Object.keys(o))),
      ].sort(),
    }
  }

  if (node.type === 'VECTOR') {
    out.vector = { vertices: node.network.vertices.length, edges: node.network.edges.length }
  }

  const children = childrenOf(node)
  if (children.length > 0) {
    out.childCount = children.length
    if (depth > 0) {
      const kids: unknown[] = []
      for (const c of children) {
        if (budget.left <= 0) {
          // Say so rather than returning a plausible-looking partial tree.
          out.truncated = `node budget of ${MAX_DETAIL_NODES} reached; ${
            children.length - kids.length
          } sibling(s) omitted — call get_node on them directly`
          break
        }
        kids.push(detail(c, depth - 1, budget))
      }
      out.children = kids
    }
  }
  return out
}

/** Shared styles, with how much of the document actually uses each one. */
function styleInventory(): unknown {
  const doc = documentStore.scene.doc
  const nodes = Object.values(doc.nodes)
  const count = (key: keyof StyleRefs, id: string): number =>
    nodes.reduce((n, node) => n + (node.styleRefs?.[key] === id ? 1 : 0), 0)

  return {
    colors: doc.styles.colors.map((s) => ({
      id: s.id,
      name: s.name,
      value: s.paint.type === 'SOLID' ? color(s.paint.color) : s.paint.type,
      usedBy: count('fill', s.id),
    })),
    texts: doc.styles.texts.map((s) => ({
      id: s.id,
      name: s.name,
      font: `${s.props.fontFamily} ${s.props.fontWeight}${s.props.italic ? ' italic' : ''} ${round(
        s.props.fontSize,
      )}px`,
      usedBy: count('text', s.id),
    })),
    effects: doc.styles.effects.map((s) => ({
      id: s.id,
      name: s.name,
      effects: s.effects.map((e) => e.type),
      usedBy: count('effect', s.id),
    })),
  }
}

/** Main components and how many instances each has. */
function componentInventory(): unknown[] {
  const nodes = Object.values(documentStore.scene.doc.nodes)
  const instances = new Map<NodeId, number>()
  for (const n of nodes) {
    if (n.type === 'INSTANCE') instances.set(n.componentId, (instances.get(n.componentId) ?? 0) + 1)
  }
  return nodes
    .filter((n) => n.type === 'COMPONENT')
    .map((n) => ({
      id: n.id,
      name: n.name,
      width: round(n.width),
      height: round(n.height),
      instances: instances.get(n.id) ?? 0,
      ...(n.type === 'COMPONENT' && n.description ? { description: n.description } : {}),
      ...(n.type === 'COMPONENT' && n.origin ? { fromLibrary: n.origin.libraryPath } : {}),
    }))
}

const HANDLERS: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>> = {
  'render.viewport': (params) => {
    const edge = Number(params.maxEdge)
    return viewportSnapshot(Number.isFinite(edge) ? edge : undefined)
  },

  'render.node': (params) => {
    const edge = Number(params.maxEdge)
    return nodeSnapshot(String(params.id ?? ''), Number.isFinite(edge) ? edge : undefined)
  },

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
      styles: styleInventory(),
      components: componentInventory(),
      libraries: (doc.libraries ?? []).map((l) => ({ name: l.name, path: l.path })),
      // Two levels is enough to orient without dumping a 100k-node scene;
      // get_node goes deeper on anything interesting.
      tree: scene.rootIds().map((id) => describe(id, 2)),
    }
  },

  'node.detail': (params) => {
    const id = String(params.id ?? '')
    const asked = Number(params.depth)
    const depth = Math.min(Math.max(Number.isFinite(asked) ? asked : 1, 0), MAX_DEPTH)
    if (!documentStore.scene.getNode(id)) {
      throw new Error(`no node with id ${JSON.stringify(id)} — ids come from get_document`)
    }
    const budget = { left: MAX_DETAIL_NODES }
    const node = detail(id, depth, budget)
    return { depth, nodesReturned: MAX_DETAIL_NODES - budget.left, node }
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
      nodeIds: [
        ...new Set(
          entry.ops
            .map((op) => ('id' in op ? op.id : op.kind === 'add' ? op.node.id : null))
            .filter(Boolean),
        ),
      ],
    }))
    return { cursor: stack.length, newEntries: entries.length, entries }
  },
}

let installed = false

/** Wire the renderer to the main-process MCP server. Safe to call twice. */
export function installAgentBridge(): void {
  if (installed) return
  installed = true
  const api = agentApi()
  api.onMcpSceneRequest((id, method, params) => {
    // Snapshots render (and settle 3D) asynchronously, so every handler is
    // awaited — a sync reply here would have shipped a pending Promise.
    void (async () => {
      try {
        const handler = HANDLERS[method]
        if (!handler) throw new Error(`unknown scene method: ${method}`)
        api.mcpSceneReply(id, true, await handler((params ?? {}) as Record<string, unknown>))
      } catch (err) {
        api.mcpSceneReply(id, false, err instanceof Error ? err.message : String(err))
      }
    })()
  })
}
