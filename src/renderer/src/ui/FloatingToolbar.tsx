// Floating tool pill, centred at the bottom of the canvas (Figma UI3
// shape). Tools sit under the pointer instead of at the far top edge, and
// the canvas gets the full height of the window back.
//
// Two deliberate differences from the old top bar:
//  - boolean ops APPEAR when 2+ layers are selected instead of sitting
//    there permanently greyed out. A control that is disabled 95% of the
//    time is just noise with a tooltip.
//  - the pill never covers the canvas edge-to-edge: it is centred with
//    pointer-events only on itself, so dragging past it still works.

import { useEditor, type Tool } from '../state/editor'
import { booleanSelection, topSelection } from '../state/actions'
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

interface ToolDef {
  tool: Tool
  title: string
  key: string
  icon: React.ReactNode
}

/** Grouped so the pill reads as select · frame · shapes · draw · view. */
const GROUPS: ToolDef[][] = [
  [
    { tool: 'select', title: 'Move', key: 'V', icon: <CursorIcon /> },
    { tool: 'hand', title: 'Hand', key: 'H', icon: <HandIcon /> },
  ],
  [{ tool: 'frame', title: 'Frame', key: 'F', icon: <FrameIcon /> }],
  [
    { tool: 'rectangle', title: 'Rectangle', key: 'R', icon: <SquareIcon /> },
    { tool: 'ellipse', title: 'Ellipse', key: 'O', icon: <CircleIcon /> },
    { tool: 'polygon', title: 'Polygon', key: '', icon: <PolygonIcon /> },
    { tool: 'star', title: 'Star', key: '', icon: <StarIcon /> },
    { tool: 'line', title: 'Line', key: 'L', icon: <LineIcon /> },
  ],
  [
    { tool: 'pen', title: 'Pen', key: 'P', icon: <PenIcon /> },
    { tool: 'text', title: 'Text', key: 'T', icon: <TypeIcon /> },
  ],
]

const BOOLEANS = [
  { op: 'UNION' as const, title: 'Union', icon: <BoolUnionIcon /> },
  { op: 'SUBTRACT' as const, title: 'Subtract', icon: <BoolSubtractIcon /> },
  { op: 'INTERSECT' as const, title: 'Intersect', icon: <BoolIntersectIcon /> },
  { op: 'EXCLUDE' as const, title: 'Exclude', icon: <BoolExcludeIcon /> },
]

export function FloatingToolbar() {
  const tool = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)
  const selection = useEditor((s) => s.selection)
  const canBool = selection.length >= 2 && topSelection().length >= 2

  return (
    <div className="absolute bottom-4 left-0 right-0 flex justify-center pointer-events-none z-20">
      <div className="pf-floating flex items-center gap-0.5 px-1.5 py-1 pointer-events-auto">
        {GROUPS.map((group, gi) => (
          <div key={gi} className="flex items-center gap-0.5">
            {gi > 0 && <span className="w-px h-5 bg-[var(--pf-border)] mx-1" />}
            {group.map((t) => (
              <button
                key={t.tool}
                title={t.key ? `${t.title} — ${t.key}` : t.title}
                aria-label={t.title}
                aria-pressed={tool === t.tool}
                className={`pf-tool-btn ${tool === t.tool ? 'active' : ''}`}
                onClick={() => setTool(t.tool)}
              >
                {t.icon}
              </button>
            ))}
          </div>
        ))}

        {/* Contextual: only while a boolean is actually possible. */}
        {canBool && (
          <div className="flex items-center gap-0.5 pf-fade-in">
            <span className="w-px h-5 bg-[var(--pf-border)] mx-1" />
            {BOOLEANS.map((b) => (
              <button
                key={b.op}
                title={b.title}
                aria-label={`Boolean ${b.title}`}
                className="pf-tool-btn"
                onClick={() => booleanSelection(b.op)}
              >
                {b.icon}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
