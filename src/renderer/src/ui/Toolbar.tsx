// Top toolbar: tools, boolean ops, project title, zoom + save.

import { useEditor, type Tool } from '../state/editor'
import { documentStore, useDocVersion } from '../state/document'
import { booleanSelection, saveFlow, topSelection, zoomAt, zoomToFit } from '../state/actions'
import {
  BoolExcludeIcon,
  BoolIntersectIcon,
  BoolSubtractIcon,
  BoolUnionIcon,
  CircleIcon,
  CursorIcon,
  FrameIcon,
  HandIcon,
  LineIcon,
  PenIcon,
  PolygonIcon,
  SquareIcon,
  StarIcon,
  TypeIcon,
} from './icons'

const TOOLS: { tool: Tool; title: string; icon: React.ReactNode }[] = [
  { tool: 'select', title: 'Move (V)', icon: <CursorIcon /> },
  { tool: 'frame', title: 'Frame (F)', icon: <FrameIcon /> },
  { tool: 'rectangle', title: 'Rectangle (R)', icon: <SquareIcon /> },
  { tool: 'ellipse', title: 'Ellipse (O)', icon: <CircleIcon /> },
  { tool: 'line', title: 'Line (L)', icon: <LineIcon /> },
  { tool: 'polygon', title: 'Polygon', icon: <PolygonIcon /> },
  { tool: 'star', title: 'Star', icon: <StarIcon /> },
  { tool: 'pen', title: 'Pen (P)', icon: <PenIcon /> },
  { tool: 'text', title: 'Text (T)', icon: <TypeIcon /> },
  { tool: 'hand', title: 'Hand (H)', icon: <HandIcon /> },
]

export function Toolbar() {
  useDocVersion()
  const tool = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)
  const selection = useEditor((s) => s.selection)
  const zoom = useEditor((s) => s.camera.zoom)
  const canBool = topSelection().length >= 2
  const title = documentStore.projectInfo?.manifest.title ?? ''
  const dirty = documentStore.dirty

  return (
    <div className="flex items-center h-12 px-2 gap-1 bg-[var(--pf-bg-0)] border-b border-[var(--pf-border)] shrink-0">
      <div className="flex items-center gap-0.5">
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            title={t.title}
            className={`pf-icon-btn ${tool === t.tool ? 'active' : ''}`}
            onClick={() => setTool(t.tool)}
          >
            {t.icon}
          </button>
        ))}
      </div>
      <div className="w-px h-6 bg-[var(--pf-border)] mx-1" />
      <div className="flex items-center gap-0.5" title={canBool ? '' : 'Select 2+ layers for boolean operations'}>
        <button className="pf-icon-btn" disabled={!canBool} style={{ opacity: canBool ? 1 : 0.35 }} title="Union" onClick={() => booleanSelection('UNION')}>
          <BoolUnionIcon />
        </button>
        <button className="pf-icon-btn" disabled={!canBool} style={{ opacity: canBool ? 1 : 0.35 }} title="Subtract" onClick={() => booleanSelection('SUBTRACT')}>
          <BoolSubtractIcon />
        </button>
        <button className="pf-icon-btn" disabled={!canBool} style={{ opacity: canBool ? 1 : 0.35 }} title="Intersect" onClick={() => booleanSelection('INTERSECT')}>
          <BoolIntersectIcon />
        </button>
        <button className="pf-icon-btn" disabled={!canBool} style={{ opacity: canBool ? 1 : 0.35 }} title="Exclude" onClick={() => booleanSelection('EXCLUDE')}>
          <BoolExcludeIcon />
        </button>
      </div>

      <div className="flex-1 flex items-center justify-center text-xs text-[var(--pf-text-dim)] truncate px-4">
        <span className="truncate">
          {title}
          {dirty ? ' •' : ''}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <span className="text-[11px] text-[var(--pf-text-dim)] w-16 text-right">{selection.length > 0 ? `${selection.length} selected` : ''}</span>
        <button className="pf-btn" title="Zoom out" onClick={() => zoomAt(null, 0.8)}>
          −
        </button>
        <button className="pf-btn w-14" title="Zoom to fit (Shift+1)" onClick={() => zoomToFit()}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="pf-btn" title="Zoom in" onClick={() => zoomAt(null, 1.25)}>
          +
        </button>
        <div className="w-px h-6 bg-[var(--pf-border)] mx-1" />
        <button className="pf-btn bg-[var(--pf-accent)] text-white hover:opacity-90" onClick={() => void saveFlow()} title="Save (Ctrl+S)">
          Save
        </button>
      </div>
    </div>
  )
}
