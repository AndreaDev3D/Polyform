// Layers panel: tree view with selection, rename, hide/lock, and pointer-based
// drag to reorder or reparent.
//
// A drag answers three questions and each gets its own signal: what am I
// carrying (a chip on the cursor), where will it land (an insertion line
// indented to the target level, or a ring around the container it nests into),
// and where did it come from (the source rows fade). Refusals say why on the
// chip instead of going quiet, and holding near either end of the list scrolls
// it. The rules themselves live in engine/layer-drop.

import { useEffect, useRef, useState } from 'react'
import type { NodeId, SceneNode } from '../engine/types'
import { isContainer } from '../engine/types'
import type { SceneGraph } from '../engine/scene'
import { documentStore, useDocVersion } from '../state/document'
import { editor, useEditor } from '../state/editor'
import {
  OpRecorder,
  addPage,
  collapseAllLayers,
  deletePage,
  expandAllLayers,
  expandSelectedLayers,
  renamePage,
  renameNode,
  setSelection,
  switchPage,
} from '../state/actions'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  EyeIcon,
  EyeOffIcon,
  FrameIcon,
  GroupIcon,
  CubeIcon,
  ImageIcon,
  LineIcon,
  LockIcon,
  PolygonIcon,
  SquareIcon,
  StarIcon,
  TrashIcon,
  TypeIcon,
  VectorIcon,
  BoolUnionIcon,
  ComponentIcon,
  InstanceIcon,
  MoreIcon,
  PlusIcon,
} from './icons'
import type { DropTarget } from '../engine/layer-drop'
import { ResizeHandle, usePanelWidth } from './panel-resize'
import { dropAtEnd, dropOnRow, instanceRefusal } from '../engine/layer-drop'
import { AssetsPanel } from './AssetsPanel'
import { ShapeIcon, hasShapeIcon } from './ShapeIcon'

/** Row indent, in px per level — shared by the rows and the drop line. */
const INDENT = 14
const INDENT_BASE = 6
/** Drag auto-scroll: edge band in px, and px per frame at its outer edge. */
const AUTOSCROLL_BAND = 32
const AUTOSCROLL_MIN = 1.5
const AUTOSCROLL_MAX = 16

function PagesSection() {
  useDocVersion()
  const [renaming, setRenaming] = useState<string | null>(null)
  const scene = documentStore.scene
  const pages = scene.doc.pages
  const activeId = scene.doc.activePageId

  return (
    <div className="border-b border-[var(--pf-border)] max-h-40 overflow-y-auto shrink-0">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold text-[var(--pf-text)]">Pages</span>
        <button className="pf-icon-btn !w-5 !h-5" title="Add page" onClick={() => addPage()}>
          <PlusIcon width={12} height={12} />
        </button>
      </div>
      {pages.map((page) => (
        <div
          key={page.id}
          className={`group flex items-center gap-2 px-3 h-7 cursor-default ${
            page.id === activeId ? 'bg-[rgba(79,158,255,0.18)] text-white' : 'hover:bg-[var(--pf-bg-2)] text-[var(--pf-text-dim)]'
          }`}
          onClick={() => switchPage(page.id)}
          onDoubleClick={() => setRenaming(page.id)}
        >
          {renaming === page.id ? (
            <input
              className="pf-input h-5 py-0 text-[11px]"
              autoFocus
              defaultValue={page.name}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                renamePage(page.id, e.target.value)
                setRenaming(null)
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setRenaming(null)
              }}
              onPointerDown={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="flex-1 truncate text-[11px]">{page.name}</span>
          )}
          {pages.length > 1 && (
            <button
              className="hidden group-hover:flex w-5 h-5 items-center justify-center text-[var(--pf-text-dim)] hover:text-white"
              title="Delete page (removes its layers)"
              onClick={(e) => {
                e.stopPropagation()
                if (window.confirm(`Delete "${page.name}" and its ${page.rootIds.length} top-level layers?`)) {
                  deletePage(page.id)
                }
              }}
            >
              <TrashIcon width={11} height={11} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function typeIcon(scene: SceneGraph, node: SceneNode) {
  // Its own silhouette, wherever the shape is the useful thing to say. Four rows
  // of "Vector" name nothing; four letterforms name themselves.
  if (hasShapeIcon(scene, node)) return <ShapeIcon scene={scene} node={node} />
  switch (node.type) {
    case 'FRAME':
      return <FrameIcon width={12} height={12} />
    case 'GROUP':
      return <GroupIcon width={12} height={12} />
    case 'BOOLEAN':
      return <BoolUnionIcon width={12} height={12} />
    case 'RECTANGLE':
      return node.fills.some((f) => f.type === 'IMAGE') ? <ImageIcon width={12} height={12} /> : <SquareIcon width={12} height={12} />
    case 'ELLIPSE':
      return <CircleIcon width={12} height={12} />
    case 'LINE':
      return <LineIcon width={12} height={12} />
    case 'POLYGON':
      return <PolygonIcon width={12} height={12} />
    case 'STAR':
      return <StarIcon width={12} height={12} />
    case 'VECTOR':
      return <VectorIcon width={12} height={12} />
    case 'TEXT':
      return <TypeIcon width={12} height={12} />
    case 'COMPONENT':
      return <ComponentIcon width={12} height={12} />
    case 'INSTANCE':
      return <InstanceIcon width={12} height={12} />
    case 'MODEL3D':
      return <CubeIcon width={12} height={12} />
  }
}

interface DragState {
  ids: NodeId[]
  /** Current drop target. */
  target: DropTarget | null
  /** Where to draw the insertion line: an edge of one visible row. */
  line: { rowId: NodeId; side: 'top' | 'bottom'; depth: number } | null
  /** Why this position refuses the drop, shown on the cursor. */
  refuse: string | null
  /** Cursor position, so the dragged layers can ride along with it. */
  pointer: { x: number; y: number }
  startedAt: { x: number; y: number }
  active: boolean
  /** Kept so capture can be taken later, when the gesture becomes a drag. */
  pointerId: number
}

interface RowInfo {
  id: NodeId
  depth: number
}

function LeftTabs() {
  const leftTab = useEditor((s) => s.leftTab)
  const setLeftTab = useEditor((s) => s.setLeftTab)
  return (
    <div className="flex items-stretch border-b border-[var(--pf-border)]">
      {(['layers', 'assets'] as const).map((tab) => (
        <button
          key={tab}
          className={`flex-1 py-2 text-[11px] font-semibold capitalize ${
            leftTab === tab ? 'text-white border-b-2 border-[var(--pf-accent)]' : 'text-[var(--pf-text-dim)]'
          }`}
          onClick={() => setLeftTab(tab)}
        >
          {tab}
        </button>
      ))}
      {/* Only over the tree, because every command in it is about the tree. A
          menu of layer commands sitting on the Assets tab is a puzzle; absent
          is clearer than present-and-inert. */}
      {leftTab === 'layers' && <TreeMenu />}
    </div>
  )
}

/**
 * The tree's own commands, in the tab strip: the ones worth having but not worth
 * a permanent button. Collapse All and Expand All are how you get a long tree
 * back under control; Expand Selected is the other half of that gesture and is
 * on the object's context menu too, because after collapsing everything the
 * layer you want is on the canvas, not in the list.
 */
function TreeMenu() {
  const [open, setOpen] = useState(false)
  const selection = useEditor((s) => s.selection)
  const ref = useRef<HTMLDivElement>(null)

  // Same dismissal as the menu bar: an outside press, Escape, or losing the
  // window. A menu left open over the tree swallows the next click on a row.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [open])

  const items: { label: string; action: () => void; disabled?: boolean; separatorAfter?: boolean }[] = [
    { label: 'Collapse All', action: collapseAllLayers },
    { label: 'Expand All', action: expandAllLayers, separatorAfter: true },
    { label: 'Expand Selected', action: expandSelectedLayers, disabled: selection.length === 0 },
  ]

  return (
    <div ref={ref} className="relative flex items-center pr-1.5">
      <button
        className={`pf-icon-btn !w-6 !h-6 ${open ? 'active' : ''}`}
        title="Layer tree options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreIcon width={14} height={14} />
      </button>
      {open && (
        // Hangs from the button at the panel's right edge, not from the panel's
        // left, so a narrow panel does not push it off the tree it acts on.
        <div className="pf-menu-panel pf-fade-in" style={{ left: 'auto', right: 4, minWidth: 176 }} role="menu">
          {items.map((item) => (
            <div key={item.label}>
              <button
                className="pf-menu-item disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--pf-text)]"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false)
                  item.action()
                }}
              >
                {item.label}
              </button>
              {item.separatorAfter && <div className="pf-menu-sep" />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function LayersPanel() {
  useDocVersion()
  const selection = useEditor((s) => s.selection)
  const leftTab = useEditor((s) => s.leftTab)
  const panel = usePanelWidth('polyform.panel.left', 256, 'right')
  // In the store, not in a useState here: Expand Selected is a context-menu
  // command given from the canvas, and it has no way to reach panel state.
  const collapsed = useEditor((s) => s.collapsedLayers)
  /** Set when a drag begins in earnest, so its trailing click is ignored. */
  const suppressClick = useRef(false)
  const [renaming, setRenaming] = useState<NodeId | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  /** Latest cursor position, for the auto-scroll loop between pointer events. */
  const pointerRef = useRef({ x: 0, y: 0 })
  const listRef = useRef<HTMLDivElement>(null)
  const scene = documentStore.scene

  // Flattened rows, topmost layer first (reverse z within each level).
  const rows: RowInfo[] = []
  const depthOf = new Map<NodeId, number>()
  const pushRows = (ids: NodeId[], depth: number) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i]
      const node = scene.getNode(id)
      if (!node) continue
      rows.push({ id, depth })
      depthOf.set(id, depth)
      if (isContainer(node) && !collapsed.has(id)) {
        pushRows(node.children, depth + 1)
      }
    }
  }
  pushRows(scene.rootIds(), 0)

  // Reveal what got selected somewhere else.
  //
  // Selecting on the canvas highlights a row you may not be able to see — or, inside
  // a collapsed group, a row that does not exist at all, so the panel looked like it
  // had not noticed. Expand the ancestors first (there is nothing to scroll to
  // otherwise), then scroll on the next frame, once the row has been rendered.
  //
  // `block: 'nearest'` on purpose: a row already in view must not be yanked to the
  // middle, because that moves the list under a pointer that is about to click it.
  const revealed = useRef('')
  useEffect(() => {
    // Mid-drag the list is being reordered by hand; do not fight it.
    if (drag?.active) return
    const key = selection.join(',')
    if (key === revealed.current) return
    revealed.current = key
    if (selection.length === 0) return

    const hidden: NodeId[] = []
    for (const id of selection) {
      for (let p = scene.parentOf(id); p; p = scene.parentOf(p)) {
        if (collapsed.has(p)) hidden.push(p)
      }
    }
    if (hidden.length > 0) {
      editor.set((s) => {
        const next = new Set(s.collapsedLayers)
        for (const id of hidden) next.delete(id)
        return { collapsedLayers: next }
      })
    }
    const scroll = () => {
      const row = listRef.current?.querySelector(`[data-layer-row="${CSS.escape(selection[0])}"]`)
      row?.scrollIntoView({ block: 'nearest' })
    }
    if (hidden.length > 0) requestAnimationFrame(scroll)
    else scroll()
    // `collapsed` is deliberately not a dependency: expanding here would re-run this
    // effect, and the `revealed` guard is what makes that harmless either way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, drag?.active])

  // Auto-scroll: hold the cursor near either end of the list and it keeps
  // scrolling, so a target off the bottom of a long tree is reachable at all.
  // Speed ramps with how far into the edge band you are — a fixed rate is
  // either too slow to be useful or too fast to aim with.
  useEffect(() => {
    if (!drag?.active) return
    const ids = drag.ids
    let raf = 0
    const step = () => {
      raf = requestAnimationFrame(step)
      const list = listRef.current
      if (!list || list.scrollHeight <= list.clientHeight) return
      const r = list.getBoundingClientRect()
      const { x, y } = pointerRef.current
      let depth = 0
      if (y < r.top + AUTOSCROLL_BAND) depth = -(r.top + AUTOSCROLL_BAND - y) / AUTOSCROLL_BAND
      else if (y > r.bottom - AUTOSCROLL_BAND) depth = (y - (r.bottom - AUTOSCROLL_BAND)) / AUTOSCROLL_BAND
      if (depth === 0) return
      const dir = Math.sign(depth)
      const t = Math.min(1, Math.abs(depth))
      const before = list.scrollTop
      list.scrollTop = before + dir * (AUTOSCROLL_MIN + (AUTOSCROLL_MAX - AUTOSCROLL_MIN) * t * t)
      // At either end of the range nothing moved, so nothing needs re-reading.
      if (list.scrollTop !== before) updateDrop(ids, x, y)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.active])

  // Escape abandons a drag, the same way it backs out of a canvas gesture.
  // Capture phase, so the global shortcut handler doesn't also clear the
  // selection on the way past.
  useEffect(() => {
    if (!drag?.active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setDrag(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [drag?.active])

  const toggleCollapse = (id: NodeId) => {
    editor.set((s) => {
      const next = new Set(s.collapsedLayers)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { collapsedLayers: next }
    })
  }

  const rowClick = (e: React.MouseEvent, id: NodeId) => {
    // A completed drag is followed by a click on whatever row the pointer was
    // released over. Acting on it would move the selection somewhere the user
    // never clicked, so the drag consumes it.
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setSelection(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id])
    } else {
      setSelection([id])
    }
  }

  // --- Drag & drop (pointer based) ---

  const beginDrag = (e: React.PointerEvent, id: NodeId) => {
    if (e.button !== 0 || renaming) return
    const ids = selection.includes(id) ? [...selection] : [id]
    // Deliberately NO setPointerCapture here. Capturing on pointerdown makes
    // the browser dispatch the following click AND dblclick to the capturing
    // row, so a click on the caret never reached the caret (it selected the
    // row instead) and the second click became a rename. Capture starts in
    // dragMove, once the gesture is actually a drag.
    pointerRef.current = { x: e.clientX, y: e.clientY }
    setDrag({
      ids,
      target: null,
      line: null,
      refuse: null,
      pointer: { x: e.clientX, y: e.clientY },
      startedAt: { x: e.clientX, y: e.clientY },
      active: false,
      pointerId: e.pointerId,
    })
  }

  /**
   * Re-read the drop target for a cursor position. Called from pointermove and
   * again from the auto-scroll loop, because scrolling moves the rows under a
   * cursor that never moved.
   */
  const updateDrop = (ids: NodeId[], x: number, y: number) => {
    const list = listRef.current
    if (!list) return
    const rowEls = Array.from(list.querySelectorAll<HTMLElement>('[data-layer-row]'))
    let placement = { target: null as DropTarget | null, side: null as 'top' | 'bottom' | null, refuse: null as string | null }
    let overId: NodeId | null = null
    for (const el of rowEls) {
      const rect = el.getBoundingClientRect()
      if (y < rect.top || y > rect.bottom) continue
      overId = el.dataset.layerRow as NodeId
      placement = dropOnRow(scene, ids, overId, (y - rect.top) / rect.height)
      break
    }
    // Past the last row, in the empty space below the tree.
    const lastRow = rowEls[rowEls.length - 1]
    if (!overId && lastRow && y > lastRow.getBoundingClientRect().bottom) {
      placement = dropAtEnd(scene, ids)
      overId = rows[rows.length - 1].id
    }

    const line =
      placement.target && placement.side && overId
        ? {
            rowId: overId,
            side: placement.side,
            // At the end of the list the line marks root level, wherever the
            // last row happens to sit in the tree.
            depth: placement.target.parentId === scene.activePage.id ? 0 : (depthOf.get(overId) ?? 0),
          }
        : null
    // Functional, because the auto-scroll loop holds a render-old `drag`.
    setDrag((prev) =>
      prev ? { ...prev, active: true, target: placement.target, line, refuse: placement.refuse, pointer: { x, y } } : prev,
    )
  }

  const dragMove = (e: React.PointerEvent) => {
    if (!drag) return
    pointerRef.current = { x: e.clientX, y: e.clientY }
    if (!drag.active && Math.abs(e.clientY - drag.startedAt.y) < 4) return
    // Past the threshold this IS a drag: take the pointer now so it keeps
    // reporting even when it leaves the list.
    if (!drag.active) {
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(drag.pointerId)
      } catch {
        // The pointer may already be gone; the drag still tracks per-row.
      }
      suppressClick.current = true
      // Dragging a row is a statement about which layers you mean.
      if (!drag.ids.every((id) => selection.includes(id))) setSelection(drag.ids)
    }
    updateDrop(drag.ids, e.clientX, e.clientY)
  }

  const endDrag = () => {
    if (drag?.active && drag.target) {
      // Structural moves in/out of instances are locked. Already reflected on
      // the cursor while dragging; re-checked because the tree could have
      // changed under a long drag.
      if (instanceRefusal(scene, drag.ids, drag.target.parentId)) {
        setDrag(null)
        return
      }
      const rec = new OpRecorder()
      const { parentId, index } = drag.target
      let insertAt = index
      // Keep panel order: move ids bottom-z first so they stack correctly.
      const rank = scene.zRank()
      const ordered = [...drag.ids].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
      for (const id of ordered) {
        const node = scene.getNode(id)
        if (!node) continue
        const fromParent = scene.parentOf(id)
        const fromIndex = scene.indexInParent(id)
        let adjusted = insertAt
        if (fromParent === parentId && fromIndex < insertAt) adjusted = Math.max(0, insertAt - 1)
        // Preserve world position across reparent.
        const m = scene.worldMatrix(id)
        const worldCenter = {
          x: m.a * (node.width / 2) + m.c * (node.height / 2) + m.e,
          y: m.b * (node.width / 2) + m.d * (node.height / 2) + m.f,
        }
        rec.move(id, parentId, adjusted)
        if (fromParent !== parentId) {
          const pm = parentId ? scene.worldMatrix(parentId) : null
          let cx = worldCenter.x
          let cy = worldCenter.y
          if (pm) {
            const det = pm.a * pm.d - pm.b * pm.c || 1
            const ix = (pm.d * (worldCenter.x - pm.e) - pm.c * (worldCenter.y - pm.f)) / det
            const iy = (-pm.b * (worldCenter.x - pm.e) + pm.a * (worldCenter.y - pm.f)) / det
            cx = ix
            cy = iy
          }
          rec.update(id, { x: cx - node.width / 2, y: cy - node.height / 2 })
        }
        insertAt = adjusted + 1
      }
      rec.commit('Reorder Layers')
    }
    setDrag(null)
  }

  if (leftTab === 'assets') {
    return (
      <div
        className="shrink-0 relative flex flex-col bg-[var(--pf-bg-0)] border-r border-[var(--pf-border)]"
        style={{ width: panel.width }}
      >
        <PagesSection />
        <LeftTabs />
        <AssetsPanel />
        <ResizeHandle edge="right" dragging={panel.dragging} onPointerDown={panel.onPointerDown} title="Drag to resize the panel" />
      </div>
    )
  }

  return (
    <div
      className="shrink-0 relative flex flex-col bg-[var(--pf-bg-0)] border-r border-[var(--pf-border)]"
      style={{ width: panel.width }}
    >
      <PagesSection />
      <LeftTabs />
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto py-1"
        // Tracked here rather than per row: moves over the empty space below
        // the tree have to count too, and a row-only handler made that depend
        // on pointer capture having been granted.
        onPointerMove={dragMove}
        onPointerUp={endDrag}
        // A pointer lost to the OS (window switch, touch cancel) would
        // otherwise leave the drag — and now its cursor chip — stuck on screen.
        onPointerCancel={() => setDrag(null)}
      >
        {rows.length === 0 && (
          <div className="px-3 py-4 text-[11px] text-[var(--pf-text-dim)]">
            Draw something on the canvas to get started — R for rectangle, F for frame.
          </div>
        )}
        {rows.map(({ id, depth }) => {
          const node = scene.getNode(id)
          if (!node) return null
          const selected = selection.includes(id)
          const isDropInto = drag?.target?.nestInto === id
          const isSource = drag?.active === true && drag.ids.includes(id)
          const line = drag?.line?.rowId === id ? drag.line : null
          const container = isContainer(node)
          return (
            <div
              key={id}
              data-layer-row={id}
              className={`group relative flex items-center gap-1 pr-2 h-7 ${
                drag?.active ? 'cursor-grabbing' : 'cursor-default'
              } ${
                isDropInto ? 'pf-drop-into' : selected ? 'bg-[rgba(79,158,255,0.22)]' : 'hover:bg-[var(--pf-bg-2)]'
              } ${node.visible ? '' : 'opacity-45'}`}
              // The rows being carried fade, so the tree reads as "these are
              // leaving". Inline, because it has to beat the utility above.
              style={{ paddingLeft: INDENT_BASE + depth * INDENT, ...(isSource ? { opacity: 0.4 } : null) }}
              onClick={(e) => rowClick(e, id)}
              // Same menu as right-clicking the object on canvas: one command
              // set, reached from wherever the layer is in front of you.
              onContextMenu={(e) => {
                e.preventDefault()
                // Right-clicking outside the selection acts on what you
                // pointed at, exactly like the canvas does; inside it, the
                // multi-selection is kept.
                if (!selection.includes(id)) setSelection([id])
                editor.set({ contextMenu: { x: e.clientX, y: e.clientY } })
              }}
              onPointerDown={(e) => beginDrag(e, id)}
            >
              {/* Insertion marker: indented to the level the layers will land
                  at, so a drop that also changes nesting says so. */}
              {line && (
                <div
                  className="pf-drop-line"
                  style={{
                    left: INDENT_BASE + line.depth * INDENT,
                    ...(line.side === 'top' ? { top: -1 } : { bottom: -1 }),
                  }}
                />
              )}
              <span
                className="w-4 h-4 flex items-center justify-center text-[var(--pf-text-dim)]"
                title={container ? (collapsed.has(id) ? 'Expand' : 'Collapse') : undefined}
                // Leaf rows have no caret, so their 16px of empty space stays
                // part of the row: still selectable, still draggable.
                onPointerDown={container ? (e) => e.stopPropagation() : undefined}
                onClick={
                  container
                    ? (e) => {
                        e.stopPropagation()
                        toggleCollapse(id)
                      }
                    : undefined
                }
                onDoubleClick={container ? (e) => e.stopPropagation() : undefined}
              >
                {container &&
                  (collapsed.has(id) ? <ChevronRightIcon width={10} height={10} /> : <ChevronDownIcon width={10} height={10} />)}
              </span>
              <span className={`shrink-0 ${selected ? 'text-white' : 'text-[var(--pf-text-dim)]'}`}>{typeIcon(scene, node)}</span>
              {renaming === id ? (
                <input
                  className="pf-input h-5 py-0 text-[11px]"
                  autoFocus
                  defaultValue={node.name}
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value !== node.name) renameNode(id, e.target.value.trim())
                    setRenaming(null)
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className={`flex-1 truncate text-[11px] ${
                    node.type === 'COMPONENT' || node.type === 'INSTANCE'
                      ? 'text-[#a78bfa]'
                      : selected
                        ? 'text-white'
                        : ''
                  }`}
                  // Rename lives on the NAME. On the whole row, double-clicking
                  // the caret to collapse renamed the layer instead.
                  title="Double-click to rename"
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setRenaming(id)
                  }}
                >
                  {node.name}
                </span>
              )}
              {/* Hidden mid-drag: pointer capture keeps :hover on the row the
                  gesture started from, so these lit up on the layer being
                  carried — where they are not clickable anyway. */}
              <span className={`${drag?.active ? 'hidden' : 'hidden group-hover:flex'} items-center gap-0.5`}>
                <button
                  className="w-5 h-5 flex items-center justify-center text-[var(--pf-text-dim)] hover:text-white"
                  title={node.locked ? 'Unlock' : 'Lock'}
                  onClick={(e) => {
                    e.stopPropagation()
                    const rec = new OpRecorder()
                    rec.update(id, { locked: !node.locked })
                    rec.commit(node.locked ? 'Unlock Layer' : 'Lock Layer')
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <LockIcon width={11} height={11} opacity={node.locked ? 1 : 0.5} />
                </button>
                <button
                  className="w-5 h-5 flex items-center justify-center text-[var(--pf-text-dim)] hover:text-white"
                  title={node.visible ? 'Hide' : 'Show'}
                  onClick={(e) => {
                    e.stopPropagation()
                    const rec = new OpRecorder()
                    rec.update(id, { visible: !node.visible })
                    rec.commit(node.visible ? 'Hide Layer' : 'Show Layer')
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {node.visible ? <EyeIcon width={11} height={11} /> : <EyeOffIcon width={11} height={11} />}
                </button>
              </span>
              {node.locked && (
                <span className="group-hover:hidden text-[var(--pf-text-dim)]">
                  <LockIcon width={11} height={11} />
                </span>
              )}
            </div>
          )
        })}
      </div>
      {drag?.active && <DragChip drag={drag} />}
      <ResizeHandle edge="right" dragging={panel.dragging} onPointerDown={panel.onPointerDown} title="Drag to resize the panel" />
    </div>
  )
}

/**
 * What you are dragging, riding the cursor — and, when the drop would nest or
 * is refused, where it is going. Fixed-positioned so it escapes the list's
 * scroll clipping, and pointer-transparent so it never becomes the drop target.
 */
function DragChip({ drag }: { drag: DragState }) {
  const scene = documentStore.scene
  const first = scene.getNode(drag.ids[0])
  const nestName = drag.target?.nestInto ? scene.getNode(drag.target.nestInto)?.name : null
  const label = drag.ids.length > 1 ? `${drag.ids.length} layers` : (first?.name ?? 'Layer')
  const note = drag.refuse ?? (nestName ? `into ${nestName}` : null)

  // Flips to the other side of the cursor near the right edge; the pointer is
  // captured, so a drag can be taken anywhere on screen, chip and all.
  const flip = drag.pointer.x > window.innerWidth - 280
  const x = flip ? `calc(${drag.pointer.x - 12}px - 100%)` : `${drag.pointer.x + 12}px`

  return (
    <div className="pf-drag-chip" style={{ transform: `translate3d(${x}, ${drag.pointer.y + 8}px, 0)` }}>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-[var(--pf-text-dim)] shrink-0">{first && typeIcon(scene, first)}</span>
        <span className="truncate">{label}</span>
      </div>
      {/* Its own line: a layer name and a refusal both want the full width,
          and on one line the sentence squeezed the name out of existence. */}
      {note && (
        <div
          className={`pl-[18px] text-[10px] truncate ${
            drag.refuse ? 'text-[var(--pf-danger)]' : 'text-[var(--pf-accent)]'
          }`}
        >
          {note}
        </div>
      )}
    </div>
  )
}
