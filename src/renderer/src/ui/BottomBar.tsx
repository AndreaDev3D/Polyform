// The bottom bar: one row that owns the things you reach for constantly.
//
// Three zones, so each has a fixed home your hand can learn:
//   left    the agent — one button, and the light that says something is
//           attached, in the same place whether or not it is
//   centre   the tools, still centred on the window
//   right    framing the view: focus the selection, then zoom
//
// It replaces the floating tool pill. The pill was centred over the canvas and
// nothing else could live on that line, so zoom sat up in the title bar, a long
// way from the canvas it acts on. A real bar can hold all three zones and stops
// hovering over the drawing.

import { useEditor, type Tool } from '../state/editor'
import { booleanSelection, topSelection, zoomAt, zoomToFit, zoomToSelection } from '../state/actions'
import { READING_WINDOW_MS, isReading, useMcpStatus } from '../agent/status'
import { useEffect, useState } from 'react'
import {
  BoolExcludeIcon,
  BoolIntersectIcon,
  BoolSubtractIcon,
  BoolUnionIcon,
  CircleIcon,
  CursorIcon,
  FocusIcon,
  FrameIcon,
  HandIcon,
  LineIcon,
  MinusIcon,
  PenIcon,
  PlusIcon,
  PolygonIcon,
  SparkIcon,
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

/** Grouped so the row reads as select · frame · shapes · draw. */
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

const ZOOM_PRESETS = [0.5, 1, 2]

/**
 * The agent button. Always present, so "let an agent in" is a thing you can
 * find rather than a menu you have to know about — and it carries the live
 * light, which used to be a separate status-bar item that only existed while
 * the endpoint was on (F-20 still holds: nothing can read the document without
 * this being visible).
 */
function AgentButton() {
  const status = useMcpStatus()
  const [now, setNow] = useState(() => Date.now())

  // Wake once to clear the pulse after the last read, rather than polling.
  useEffect(() => {
    if (status.lastCallAt === null) return
    const left = status.lastCallAt + READING_WINDOW_MS - Date.now()
    if (left <= 0) return
    const t = window.setTimeout(() => setNow(Date.now()), left)
    return () => window.clearTimeout(t)
  }, [status.lastCallAt])

  const reading = isReading(status, now)
  const connected = status.clients > 0
  const label = !status.running
    ? 'Agent'
    : reading
      ? status.lastCall === 'edit'
        ? 'Editing'
        : `Reading ${status.lastCall}`
      : connected
        ? `Connected${status.clients > 1 ? ` (${status.clients})` : ''}`
        : 'Listening'

  return (
    <button
      className={`pf-btn h-7 pl-1.5 pr-2.5 gap-1.5 ${status.running ? 'bg-[var(--pf-bg-2)]' : ''}`}
      title={
        status.running
          ? 'An agent can reach this document — click to review or revoke what it can read'
          : 'Let an AI agent connect to this document'
      }
      onClick={() => useEditor.setState({ showAgent: true })}
    >
      <SparkIcon width={13} height={13} />
      <span className="text-[11px]">{label}</span>
      {status.running && (
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full ${
            reading ? 'bg-[#43c463]' : connected ? 'bg-[#43c463] opacity-70' : 'bg-[#d8a13a]'
          }`}
        />
      )}
    </button>
  )
}

export function BottomBar() {
  const tool = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)
  const selection = useEditor((s) => s.selection)
  const zoom = useEditor((s) => s.camera.zoom)
  const canBool = selection.length >= 2 && topSelection().length >= 2

  return (
    // Explicit px: the root font size is 12px, so Tailwind's rem heights come
    // out 0.75× and h-11 would be a cramped 33px row.
    <div className="flex items-center h-[40px] px-2 gap-2 bg-[var(--pf-bg-0)] border-t border-[var(--pf-border)] shrink-0">
      {/* Left: the agent. Fixed-width zones keep the tools centred on the
          window however wide either side's contents get. */}
      <div className="flex-1 min-w-0 flex items-center">
        <AgentButton />
      </div>

      {/* Centre: tools. `relative` so the contextual booleans can hang off the
          end without shifting the tools — their positions are muscle memory,
          and they used to jump left the moment you selected a second layer. */}
      <div className="relative flex items-center gap-0.5 shrink-0">
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

        {/* Contextual: booleans appear only while one is actually possible. A
            control that is disabled 95% of the time is noise with a tooltip. */}
        {canBool && (
          <div className="absolute left-full top-0 h-full flex items-center gap-0.5 pf-fade-in">
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

      {/* Right: framing the view — next to the canvas it acts on, not up in
          the title bar. */}
      <div className="flex-1 min-w-0 flex items-center justify-end gap-1.5">
        <button
          className="pf-tool-btn"
          title={
            selection.length > 0
              ? `Focus on ${selection.length === 1 ? 'the selection' : `${selection.length} layers`} — Shift+2`
              : 'Nothing selected — fits the whole page'
          }
          aria-label="Focus on selection"
          onClick={() => zoomToSelection()}
        >
          <FocusIcon />
        </button>
        <div className="flex items-center gap-0.5 rounded-md bg-[var(--pf-bg-2)] p-0.5">
          <button className="pf-tool-btn h-6 w-6" title="Zoom out — Ctrl+−" aria-label="Zoom out" onClick={() => zoomAt(null, 0.8)}>
            <MinusIcon />
          </button>
          <button
            className="pf-btn h-6 px-2 text-[11px] tabular-nums min-w-[3.25rem]"
            // The readout fits the whole page; the focus button beside it is
            // the one that goes to the selection.
            title="Zoom to fit the page — Shift+1 (right-click for presets)"
            onClick={() => zoomToFit()}
            onContextMenu={(e) => {
              e.preventDefault()
              const next = ZOOM_PRESETS.find((z) => z > zoom + 0.01) ?? ZOOM_PRESETS[0]
              zoomAt(null, next / zoom)
            }}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button className="pf-tool-btn h-6 w-6" title="Zoom in — Ctrl+=" aria-label="Zoom in" onClick={() => zoomAt(null, 1.25)}>
            <PlusIcon />
          </button>
        </div>
      </div>
    </div>
  )
}
