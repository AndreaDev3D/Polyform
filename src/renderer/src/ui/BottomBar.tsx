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

import { useEditor, type Tool, type VectorMode } from '../state/editor'
import {
  booleanSelection,
  bridgeVectorPoints,
  closeVectorPath,
  dissolveVectorParts,
  carveSelection,
  joinVectorPoints,
  topSelection,
  zoomTo,
  zoomToSelection,
} from '../state/actions'
import { interactionController } from '../interactions/controller'
import { READING_WINDOW_MS, isReading, useMcpStatus } from '../agent/status'
import { useEffect, useRef, useState } from 'react'
import { MENU, formatAccelerator } from '../../../shared/menu-def'
import type { MenuItemDef } from '../../../shared/menu-def'
import { formatZoom, parseZoomText } from '../engine/zoom'
import { ColorPicker } from './ColorPicker'
import { rgbaToCss, rgbaToHex } from '../engine/color'
import {
  BendIcon,
  BridgeIcon,
  BucketIcon,
  ClosePathIcon,
  DissolveIcon,
  JoinIcon,
  KnifeIcon,
  PointAddIcon,
  BoolExcludeIcon,
  BoolIntersectIcon,
  BoolSubtractIcon,
  BoolUnionIcon,
  CarveIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  CloseIcon,
  CursorIcon,
  FocusIcon,
  FrameIcon,
  HandIcon,
  LineIcon,
  PenIcon,
  PointDeleteIcon,
  PointMoveIcon,
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

/**
 * The zoom control: a percentage that opens a menu, in place of the −/+/readout
 * box. That box could only do three things and hid the rest of them, so "zoom to
 * 200%" meant right-clicking a button whose tooltip mentioned presets.
 *
 * The rows for commands are built from the SHARED menu definition, so their
 * labels and shortcuts come from the same place the menu bar and the native
 * accelerators do, and they run through `menuInvoke` — one implementation per
 * command (see MenuBar). The presets and the typed percentage have no menu item
 * behind them and call the camera directly.
 */
const VIEW_MENU = MENU.find((m) => m.label === 'View')
const viewItem = (id: string): MenuItemDef | undefined => VIEW_MENU?.items.find((i) => i.id === id)

function ZoomMenu() {
  const zoom = useEditor((s) => s.camera.zoom)
  const showGrid = useEditor((s) => s.showGrid)
  const showRulers = useEditor((s) => s.showRulers)
  const gpuRender = useEditor((s) => s.gpuRender)
  const gpuSupported = useEditor((s) => s.gpuSupported)
  const gpuActive = useEditor((s) => s.gpuActive)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const platform = window.polyform.platform

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
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

  const accel = (id: string): string | null => {
    const item = viewItem(id)
    return item?.accelerator ? formatAccelerator(item.accelerator, platform) : null
  }
  const run = (id: string) => {
    setOpen(false)
    void window.polyform.menuInvoke(id).then((ok) => {
      if (!ok) console.warn(`[polyform] no native menu item "${id}"`)
    })
  }
  const jump = (level: number) => {
    setOpen(false)
    zoomTo(level)
  }

  /** One row. `checked === undefined` means it is a command, not a toggle. */
  const Row = ({
    label,
    shortcut,
    checked,
    title,
    disabled,
    onSelect,
  }: {
    label: string
    shortcut?: string | null
    checked?: boolean
    title?: string
    disabled?: boolean
    onSelect: () => void
  }) => (
    <button
      className="pf-menu-item"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked === undefined ? undefined : checked}
      title={title}
      disabled={disabled}
      onClick={onSelect}
    >
      {/* The gutter is reserved on every row, ticked or not, so the labels line
          up instead of stepping in and out as things are switched on. */}
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="pf-menu-check">{checked ? <CheckIcon width={11} height={11} /> : null}</span>
        <span className="truncate">{label}</span>
      </span>
      {shortcut ? <span className="pf-menu-accel">{shortcut}</span> : null}
    </button>
  )

  return (
    <div ref={rootRef} className="relative">
      <button
        className={`pf-select h-[30px] w-[4.75rem] justify-between tabular-nums ${open ? 'is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Zoom and view options"
        title="Zoom and view options"
        onClick={() => setOpen(!open)}
      >
        <span className="pf-select-value">{formatZoom(zoom)}</span>
        <ChevronDownIcon className="pf-select-caret" width={10} height={10} />
      </button>
      {open && (
        <div className="pf-menu-panel pf-menu-panel-up pf-fade-in" role="menu">
          {/* Typing a percentage is the fast path, so it is focused on open and
              its text is selected: open, type, Enter. */}
          <div className="px-2 pb-1.5 pt-1">
            <input
              className="pf-input h-[26px] text-[12px] tabular-nums"
              autoFocus
              defaultValue={formatZoom(zoom)}
              aria-label="Zoom level"
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                // The global shortcuts already ignore fields; Escape and Enter
                // are ours, and must not also reach the canvas behind us.
                e.stopPropagation()
                if (e.key === 'Enter') {
                  const parsed = parseZoomText((e.target as HTMLInputElement).value)
                  if (parsed !== null) jump(parsed)
                  else setOpen(false)
                }
                if (e.key === 'Escape') setOpen(false)
              }}
            />
          </div>
          <Row label="Zoom in" shortcut={accel('view.zoomIn')} onSelect={() => run('view.zoomIn')} />
          <Row label="Zoom out" shortcut={accel('view.zoomOut')} onSelect={() => run('view.zoomOut')} />
          <Row label="Zoom to fit" shortcut={accel('view.zoomFit')} onSelect={() => run('view.zoomFit')} />
          <Row
            label="Focus on selection"
            shortcut={accel('view.zoomSelection')}
            title="With nothing selected this fits the whole page"
            onSelect={() => run('view.zoomSelection')}
          />
          <Row label="Zoom to 50%" onSelect={() => jump(0.5)} />
          <Row label="Zoom to 100%" shortcut={accel('view.zoomActual')} onSelect={() => run('view.zoomActual')} />
          <Row label="Zoom to 200%" onSelect={() => jump(2)} />
          <div className="pf-menu-sep" />
          <Row
            label="Grid"
            shortcut={accel('view.toggleGrid')}
            checked={showGrid}
            title="An 8 px grid. The 1 px pixel grid appears on its own past 800%."
            onSelect={() => run('view.toggleGrid')}
          />
          <Row
            label="Rulers"
            shortcut={accel('view.toggleRulers')}
            checked={showRulers}
            onSelect={() => run('view.toggleRulers')}
          />
          {/* The tick follows what is DRAWING, not what was asked for: a device
              can be requested and fail, and a tick that survives that is a lie
              about the renderer you are using (F-30). */}
          <Row
            label="GPU rendering"
            checked={gpuActive}
            disabled={!gpuSupported}
            title={
              !gpuSupported
                ? 'No WebGPU device on this machine — drawing with the CPU renderer'
                : gpuRender && !gpuActive
                  ? 'Asked for, but the device could not be created — drawing with the CPU renderer'
                  : 'On by default: 100,000 shapes at 60fps, pixel-checked against the CPU renderer'
            }
            onSelect={() => run('view.toggleGpu')}
          />
        </div>
      )}
    </div>
  )
}

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
      className={`pf-btn h-[30px] pl-1.5 pr-2.5 gap-1.5 ${status.running ? 'bg-[var(--pf-bg-2)]' : ''}`}
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

const VECTOR_MODES: { mode: VectorMode; title: string; hint: string; icon: React.ReactNode }[] = [
  { mode: 'move', title: 'Move', hint: 'Drag points and handles · click a segment to add a point', icon: <PointMoveIcon /> },
  {
    mode: 'add',
    title: 'Add',
    hint: 'A dot rides the outline showing where the point lands · click a point you already have to pick it up instead',
    icon: <PointAddIcon />,
  },
  { mode: 'bend', title: 'Bend', hint: 'Drag a segment and the curve follows the pointer', icon: <BendIcon /> },
  {
    mode: 'knife',
    title: 'Knife',
    hint: 'Drag across the shape, or click twice, to cut it in two · ends snap to points',
    icon: <KnifeIcon />,
  },
  {
    mode: 'paint',
    title: 'Paint',
    hint: 'Click inside a closed part to give it its own colour · click it again to take it back',
    icon: <BucketIcon />,
  },
  { mode: 'delete', title: 'Delete', hint: 'Click a point to remove it · click a segment to open the path', icon: <PointDeleteIcon /> },
]

/**
 * The bucket's colour, and the picker for it.
 *
 * Its own swatch rather than the inspector's Fill row, because the two mean
 * different things: the Fill row is the SHAPE's colour, and painting a part is
 * saying "this bit, not that". Sharing one control would make the first click
 * of the bucket a no-op — you would be filling a part with the colour it
 * already has.
 */
function PaintSwatch() {
  const color = useEditor((s) => s.paintColor)
  const setColor = useEditor((s) => s.setPaintColor)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const rect = ref.current?.getBoundingClientRect()

  return (
    <>
      <button
        ref={ref}
        className="pf-tool-btn"
        title={`Paint colour — ${rgbaToHex(color)}`}
        aria-label="Paint colour"
        onClick={() => setOpen(!open)}
      >
        <span
          className="w-4 h-4 rounded-[3px] border border-[rgba(255,255,255,0.35)]"
          style={{ background: rgbaToCss(color, 1) }}
        />
      </button>
      {open && rect && (
        <ColorPicker
          color={color}
          anchor={{ x: rect.left, y: rect.top }}
          onLive={(c) => setColor(c)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/**
 * While a vector is open for editing, the centre of the bar becomes its own
 * tools. Swapping rather than stacking, because you cannot draw a rectangle
 * mid-path anyway, and one row keeps the modes where the tools already were.
 */
function VectorModes() {
  const mode = useEditor((s) => s.vectorMode)
  const setMode = useEditor((s) => s.setVectorMode)
  const points = useEditor((s) => s.vectorSelection)

  return (
    <div className="flex items-center gap-0.5 shrink-0">
      {VECTOR_MODES.map((m) => (
        <button
          key={m.mode}
          className={`pf-btn h-[30px] px-2 gap-1.5 ${mode === m.mode ? 'bg-[var(--pf-accent-solid)] text-white' : ''}`}
          title={`${m.title} — ${m.hint}`}
          aria-pressed={mode === m.mode}
          onClick={() => setMode(m.mode)}
        >
          {m.icon}
          <span className="text-[11px]">{m.title}</span>
        </button>
      ))}
      {/* Only while the bucket is out: a colour well with no bucket selected is
          a control with nothing to apply it to. */}
      {mode === 'paint' && <PaintSwatch />}
      <span className="w-px h-5 bg-[var(--pf-border)] mx-1" />
      {/* Commands, not modes: they act on the points already selected and hand
          the tool straight back. Icon-only and unpressed, so they do not read
          as a state you are now in. */}
      <button
        className="pf-tool-btn"
        title="Join — connect two selected points with a segment"
        aria-label="Join points"
        disabled={points.length !== 2}
        onClick={() => joinVectorPoints()}
      >
        <JoinIcon />
      </button>
      <button
        className="pf-tool-btn"
        title="Bridge — connect selected points across two detached parts of this shape"
        aria-label="Bridge parts"
        disabled={points.length < 2}
        onClick={() => bridgeVectorPoints()}
      >
        <BridgeIcon />
      </button>
      {/* The repair for a path that looks closed and is not. Ungated for the
          same reason Dissolve is, and because the anchors it welds are exactly
          the ones you cannot select: two in the same place. */}
      <button
        className="pf-tool-btn"
        title="Close path — weld loose ends that are sitting on top of each other, so a fill has something to fill"
        aria-label="Close path"
        onClick={() => closeVectorPath()}
      >
        <ClosePathIcon />
      </button>
      {/* Not gated on the selection: dissolve acts on the whole path, because
          which parts overlap is a fact about the shape rather than about what
          you happen to have clicked. */}
      <button
        className="pf-tool-btn"
        title="Dissolve — merge overlapping parts of this shape into one outline"
        aria-label="Dissolve overlapping parts"
        onClick={() => dissolveVectorParts()}
      >
        <DissolveIcon />
      </button>
      <span className="w-px h-5 bg-[var(--pf-border)] mx-1" />
      <span className="text-[11px] text-[var(--pf-text-dim)] tabular-nums px-1">
        {points.length > 0 ? `${points.length} point${points.length > 1 ? 's' : ''}` : 'no point selected'}
      </span>
      <button
        className="pf-tool-btn"
        title="Finish editing this path — Esc"
        aria-label="Finish editing"
        onClick={() => interactionController.exitVectorEdit(true)}
      >
        <CloseIcon />
      </button>
    </div>
  )
}

export function BottomBar() {
  const tool = useEditor((s) => s.tool)
  const setTool = useEditor((s) => s.setTool)
  const selection = useEditor((s) => s.selection)
  const vectorEditId = useEditor((s) => s.vectorEditId)
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

      {/* Centre: tools, or the vector modes while a path is open. `relative` so
          the contextual booleans can hang off the end without shifting the
          tools — their positions are muscle memory, and they used to jump left
          the moment you selected a second layer. */}
      {vectorEditId ? (
        <VectorModes />
      ) : (
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
            {/* Carve sits with the booleans because it answers the same
                question — combine these shapes — but bakes one editable path
                with holes instead of a live operation. */}
            <button
              title="Carve holes — the shapes on top cut through the one underneath, as one editable path (Ctrl+Shift+H)"
              aria-label="Carve holes"
              className="pf-tool-btn"
              onClick={() => carveSelection()}
            >
              <CarveIcon />
            </button>
          </div>
        )}
      </div>
      )}

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
        <ZoomMenu />
      </div>
    </div>
  )
}
