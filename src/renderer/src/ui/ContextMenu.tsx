// Right-click context menu on the canvas.

import { useEffect, useRef } from 'react'
import { useEditor } from '../state/editor'
import {
  booleanSelection,
  copySelection,
  createComponentFromSelection,
  createInstanceFromSelection,
  deleteSelection,
  detachSelectedInstances,
  duplicateSelection,
  frameSelection,
  groupSelection,
  paste,
  reorderSelection,
  toggleMaskSelection,
  ungroupSelection,
} from '../state/actions'
import { documentStore } from '../state/document'

interface Item {
  label: string
  shortcut?: string
  action: () => void
  separatorAfter?: boolean
  disabled?: boolean
}

export function ContextMenu() {
  const contextMenu = useEditor((s) => s.contextMenu)
  const setContextMenu = useEditor((s) => s.setContextMenu)
  const selection = useEditor((s) => s.selection)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', close)
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', close)
    }
  }, [contextMenu, setContextMenu])

  if (!contextMenu) return null
  const has = selection.length > 0
  const multi = selection.length >= 2

  const items: Item[] = [
    { label: 'Copy', shortcut: 'Ctrl+C', action: copySelection, disabled: !has },
    { label: 'Paste', shortcut: 'Ctrl+V', action: paste },
    { label: 'Duplicate', shortcut: 'Ctrl+D', action: duplicateSelection, disabled: !has },
    { label: 'Delete', shortcut: 'Del', action: deleteSelection, disabled: !has, separatorAfter: true },
    { label: 'Group Selection', shortcut: 'Ctrl+G', action: groupSelection, disabled: !multi },
    { label: 'Ungroup', shortcut: 'Ctrl+Shift+G', action: ungroupSelection, disabled: !has },
    { label: 'Frame Selection', shortcut: 'Ctrl+Alt+G', action: frameSelection, disabled: !has, separatorAfter: true },
    { label: 'Create Component', shortcut: 'Ctrl+Alt+K', action: createComponentFromSelection, disabled: !has },
    {
      label: 'Create Instance',
      action: createInstanceFromSelection,
      disabled: !selection.some((id) => documentStore.scene.getNode(id)?.type === 'COMPONENT'),
    },
    {
      label: 'Detach Instance',
      shortcut: 'Ctrl+Alt+B',
      action: detachSelectedInstances,
      disabled: !selection.some((id) => documentStore.scene.getNode(id)?.type === 'INSTANCE'),
    },
    { label: 'Use as Mask', shortcut: 'Ctrl+Alt+M', action: toggleMaskSelection, disabled: !has, separatorAfter: true },
    { label: 'Bring to Front', shortcut: 'Ctrl+Shift+]', action: () => reorderSelection('front'), disabled: !has },
    { label: 'Bring Forward', shortcut: 'Ctrl+]', action: () => reorderSelection('forward'), disabled: !has },
    { label: 'Send Backward', shortcut: 'Ctrl+[', action: () => reorderSelection('backward'), disabled: !has },
    { label: 'Send to Back', shortcut: 'Ctrl+Shift+[', action: () => reorderSelection('back'), disabled: !has, separatorAfter: true },
    { label: 'Union Selection', action: () => booleanSelection('UNION'), disabled: !multi },
    { label: 'Subtract Selection', action: () => booleanSelection('SUBTRACT'), disabled: !multi },
    { label: 'Intersect Selection', action: () => booleanSelection('INTERSECT'), disabled: !multi },
    { label: 'Exclude Selection', action: () => booleanSelection('EXCLUDE'), disabled: !multi },
  ]

  const x = Math.min(contextMenu.x, window.innerWidth - 240)
  const y = Math.min(contextMenu.y, window.innerHeight - items.length * 26 - 20)

  return (
    <div
      ref={ref}
      className="fixed z-50 w-56 py-1 rounded-md shadow-xl border border-[var(--pf-border)] bg-[#252525]"
      style={{ left: x, top: y }}
    >
      {items.map((item, i) => (
        <div key={i}>
          <button
            className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-left hover:bg-[var(--pf-accent-solid)] hover:text-white disabled:opacity-40 disabled:hover:bg-transparent"
            disabled={item.disabled}
            onClick={() => {
              setContextMenu(null)
              item.action()
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="text-[10px] opacity-60">{item.shortcut}</span>}
          </button>
          {item.separatorAfter && <div className="h-px my-1 bg-[var(--pf-border)]" />}
        </div>
      ))}
    </div>
  )
}
