// Bottom status bar: contextual hints, counts, zoom.

import { useEditor } from '../state/editor'
import { documentStore, useDocVersion } from '../state/document'
import { AgentIndicator } from './AgentIndicator'

const TOOL_HINTS: Record<string, string> = {
  select: 'Click to select · drag to move · double-click to enter groups · Ctrl+click for deep select',
  frame: 'Drag to draw a frame · click for a preset frame',
  rectangle: 'Drag to draw · Shift for a square',
  ellipse: 'Drag to draw · Shift for a circle',
  line: 'Drag to draw · Shift snaps to 45°',
  polygon: 'Drag to draw a polygon',
  star: 'Drag to draw a star',
  pen: 'Click to add points · click the first point to close · Enter to finish · Esc to cancel',
  text: 'Click to place text',
  hand: 'Drag to pan',
}

export function StatusBar() {
  useDocVersion()
  const tool = useEditor((s) => s.tool)
  const status = useEditor((s) => s.status)
  const zoom = useEditor((s) => s.camera.zoom)
  const nodeCount = Object.keys(documentStore.scene.doc.nodes).length
  const canUndo = documentStore.history.canUndo
  const undoLabel = documentStore.history.peekUndoLabel()

  return (
    <div className="flex items-center h-6 px-3 gap-4 text-[11px] text-[var(--pf-text-dim)] bg-[var(--pf-bg-0)] border-t border-[var(--pf-border)] shrink-0">
      {/* A message displaces the tool hint: it is the thing worth reading. */}
      {status ? (
        <span className="truncate text-[var(--pf-text)]">{status}</span>
      ) : (
        <span className="truncate">{TOOL_HINTS[tool]}</span>
      )}
      <span className="flex-1" />
      <AgentIndicator />
      {canUndo && undoLabel && <span className="truncate max-w-48">Last: {undoLabel}</span>}
      <span>{nodeCount} layers</span>
      <span>{Math.round(zoom * 100)}%</span>
    </div>
  )
}
