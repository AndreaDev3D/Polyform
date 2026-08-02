// Layers panel: tree view with selection, rename, hide/lock, and pointer-based
// drag to reorder or reparent (drop line above/below, highlight to nest).

import { useRef, useState } from 'react'
import type { NodeId, SceneNode } from '../engine/types'
import { isContainer } from '../engine/types'
import { documentStore, useDocVersion } from '../state/document'
import { useEditor } from '../state/editor'
import { OpRecorder, addPage, deletePage, renamePage, renameNode, setSelection, switchPage } from '../state/actions'
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
  PlusIcon,
} from './icons'
import { isInsideInstance } from '../engine/hit-test'
import { AssetsPanel } from './AssetsPanel'

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

function typeIcon(node: SceneNode) {
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
  target: { parentId: NodeId | null; index: number; nestInto: NodeId | null } | null
  startedAt: { x: number; y: number }
  active: boolean
}

interface RowInfo {
  id: NodeId
  depth: number
}

function LeftTabs() {
  const leftTab = useEditor((s) => s.leftTab)
  const setLeftTab = useEditor((s) => s.setLeftTab)
  return (
    <div className="flex border-b border-[var(--pf-border)]">
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
    </div>
  )
}

export function LayersPanel() {
  useDocVersion()
  const selection = useEditor((s) => s.selection)
  const leftTab = useEditor((s) => s.leftTab)
  const [collapsed, setCollapsed] = useState<Set<NodeId>>(new Set())
  const [renaming, setRenaming] = useState<NodeId | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const scene = documentStore.scene

  // Flattened rows, topmost layer first (reverse z within each level).
  const rows: RowInfo[] = []
  const pushRows = (ids: NodeId[], depth: number) => {
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i]
      const node = scene.getNode(id)
      if (!node) continue
      rows.push({ id, depth })
      if (isContainer(node) && !collapsed.has(id)) {
        pushRows(node.children, depth + 1)
      }
    }
  }
  pushRows(scene.rootIds(), 0)

  const toggleCollapse = (id: NodeId) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const rowClick = (e: React.MouseEvent, id: NodeId) => {
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
    setDrag({ ids, target: null, startedAt: { x: e.clientX, y: e.clientY }, active: false })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const dragMove = (e: React.PointerEvent) => {
    if (!drag) return
    if (!drag.active && Math.abs(e.clientY - drag.startedAt.y) < 4) return
    const list = listRef.current
    if (!list) return
    const rowEls = Array.from(list.querySelectorAll<HTMLElement>('[data-layer-row]'))
    let target: DragState['target'] = null
    for (const el of rowEls) {
      const rect = el.getBoundingClientRect()
      if (e.clientY < rect.top || e.clientY > rect.bottom) continue
      const overId = el.dataset.layerRow as NodeId
      if (drag.ids.includes(overId)) break
      const node = scene.getNode(overId)
      if (!node) break
      // Refuse dropping into own descendant.
      if (drag.ids.some((d) => scene.isAncestorOf(d, overId) || d === overId)) break
      const ratio = (e.clientY - rect.top) / rect.height
      if (isContainer(node) && ratio > 0.3 && ratio < 0.7) {
        target = { parentId: overId, index: node.children.length, nestInto: overId }
      } else {
        const parentId = scene.parentOf(overId)
        const siblings = scene.childListOf(parentId)
        const overIndex = siblings.indexOf(overId)
        // Panel shows reverse z-order: "above" visually = higher z = after in list.
        const index = ratio <= 0.5 ? overIndex + 1 : overIndex
        target = { parentId, index, nestInto: null }
      }
      break
    }
    setDrag({ ...drag, active: true, target })
  }

  const endDrag = () => {
    if (drag?.active && drag.target) {
      // Structural moves in/out of instances are locked.
      const blocked =
        drag.ids.some((id) => isInsideInstance(scene, id)) ||
        (drag.target.parentId !== null &&
          !scene.isPage(drag.target.parentId) &&
          (scene.getNode(drag.target.parentId)?.type === 'INSTANCE' ||
            isInsideInstance(scene, drag.target.parentId)))
      if (blocked) {
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
      <div className="w-64 shrink-0 flex flex-col bg-[var(--pf-bg-0)] border-r border-[var(--pf-border)]">
        <PagesSection />
        <LeftTabs />
        <AssetsPanel />
      </div>
    )
  }

  return (
    <div className="w-64 shrink-0 flex flex-col bg-[var(--pf-bg-0)] border-r border-[var(--pf-border)]">
      <PagesSection />
      <LeftTabs />
      <div ref={listRef} className="flex-1 overflow-y-auto py-1" onPointerUp={endDrag}>
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
          const container = isContainer(node)
          return (
            <div
              key={id}
              data-layer-row={id}
              className={`group relative flex items-center gap-1 pr-2 h-7 cursor-default ${
                selected ? 'bg-[rgba(79,158,255,0.22)]' : isDropInto ? 'bg-[rgba(79,158,255,0.12)]' : 'hover:bg-[var(--pf-bg-2)]'
              } ${node.visible ? '' : 'opacity-45'}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              onClick={(e) => rowClick(e, id)}
              onDoubleClick={() => setRenaming(id)}
              onPointerDown={(e) => beginDrag(e, id)}
              onPointerMove={dragMove}
            >
              <span
                className="w-4 h-4 flex items-center justify-center text-[var(--pf-text-dim)]"
                onClick={(e) => {
                  e.stopPropagation()
                  if (container) toggleCollapse(id)
                }}
              >
                {container &&
                  (collapsed.has(id) ? <ChevronRightIcon width={10} height={10} /> : <ChevronDownIcon width={10} height={10} />)}
              </span>
              <span className={`shrink-0 ${selected ? 'text-white' : 'text-[var(--pf-text-dim)]'}`}>{typeIcon(node)}</span>
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
                >
                  {node.name}
                </span>
              )}
              <span className="hidden group-hover:flex items-center gap-0.5">
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
    </div>
  )
}
