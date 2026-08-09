// Right-hand inspector: transform, appearance, fills/strokes/effects, text,
// auto layout, boolean ops, export. Edits apply to the whole selection and
// commit through the history system (live color edits commit on close).

import { useRef, useState, useSyncExternalStore } from 'react'
import { bgRemoveState, onBgRemoveState, removeBackground, restoreOriginal } from './bgremove'
import type {
  AutoLayout,
  BlendMode,
  BooleanOp,
  Constraint,
  Effect,
  EllipseNode,
  FrameNode,
  GradientPaint,
  ImagePaint,
  InstanceNode,
  LightingPreset,
  MirrorMode,
  Model3dNode,
  ModelPose,
  NodeId,
  Paint,
  RGBA,
  SceneNode,
  TextNode,
  VectorNode,
} from '../engine/types'
import { defaultPose, solid } from '../engine/types'
import {
  fillPaintBox,
  gradientAngle,
  strokeAlignApplies,
  strokePaintBox,
  withGradientAngle,
  type PaintBox,
} from '../engine/paintbox'
import { isFullEllipse } from '../engine/shapes'
import { setVertexMirror } from '../engine/vector-edit'
import { isSplatFormat } from '../render3d/island'
import { documentStore, useDocVersion } from '../state/document'
import { useEditor } from '../state/editor'
import {
  alignSelection,
  applyColorStyle,
  applyTextStyle,
  createColorStyle,
  createTextStyle,
  deleteSharedStyle,
  detachSelectedInstances,
  detachStyle,
  distributeSelection,
  flipSelection,
  rotateSelection,
  renameSharedStyle,
  resetInstanceOverrides,
  runExports,
  selectedIds,
  setSelectionSize,
  swapInstanceComponent,
  toggleMaskSelection,
  updateColorStyle,
  updateSelectedNodes,
} from '../state/actions'
import type { ExportTarget } from '../state/actions'
import { listComponents } from '../engine/components'
import { ComponentIcon , SwapIcon } from './icons'
import type { PatchOp } from '../engine/commands'
import { Field, NumberInput, Section, Segmented, Select, round } from './components'
import { ColorPicker, type PickerPaintType } from './ColorPicker'
import { rgbaToCss, rgbaToHex } from '../engine/color'
import { defaultColorStyleName, defaultTextStyleName, uniqueStyleName } from '../engine/stylename'
import {
  AlignBottomIcon,
  AlignHCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignTopIcon,
  AlignVCenterIcon,
  BlurIcon,
  CornerBLIcon,
  CornerBRIcon,
  CornerRadiusIcon,
  CornerTLIcon,
  CornerTRIcon,
  CornersIcon,
  DistributeHIcon,
  DistributeVIcon,
  ExportIcon,
  EyeIcon,
  EyeOffIcon,
  MinusIcon,
  MirrorAngleIcon,
  MirrorFullIcon,
  MirrorNoneIcon,
  OpacityIcon,
  PlusIcon,
  Rotate90Icon,
  RotationIcon,
  FlipHIcon,
  FlipVIcon,
  StrokeWeightIcon,
  TextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TextBottomIcon,
  TextMiddleIcon,
  TextTopIcon,
} from './icons'
import { ResizeHandle, usePanelWidth } from './panel-resize'

const BLEND_OPTIONS: { value: BlendMode; label: string }[] = [
  { value: 'NORMAL', label: 'Normal' },
  { value: 'MULTIPLY', label: 'Multiply' },
  { value: 'SCREEN', label: 'Screen' },
  { value: 'OVERLAY', label: 'Overlay' },
  { value: 'DARKEN', label: 'Darken' },
  { value: 'LIGHTEN', label: 'Lighten' },
  { value: 'COLOR_DODGE', label: 'Color dodge' },
  { value: 'COLOR_BURN', label: 'Color burn' },
  { value: 'HARD_LIGHT', label: 'Hard light' },
  { value: 'SOFT_LIGHT', label: 'Soft light' },
  { value: 'DIFFERENCE', label: 'Difference' },
  { value: 'EXCLUSION', label: 'Exclusion' },
]

interface PickerState {
  kind: 'fill' | 'stroke' | 'effect'
  index: number
  stopIndex?: number
  anchor: { x: number; y: number }
}

/** The four corner fields, each with the corner it edits drawn on it. */
const CORNERS = [
  { key: 'tl', Icon: CornerTLIcon, label: 'Top left' },
  { key: 'tr', Icon: CornerTRIcon, label: 'Top right' },
  { key: 'bl', Icon: CornerBLIcon, label: 'Bottom left' },
  { key: 'br', Icon: CornerBRIcon, label: 'Bottom right' },
] as const

export function Inspector() {
  useDocVersion()
  const selection = useEditor((s) => s.selection)
  const fonts = useEditor((s) => s.fonts)
  const vectorEditId = useEditor((s) => s.vectorEditId)
  const [picker, setPicker] = useState<PickerState | null>(null)
  /** null = follow the shape (expand when its corners differ); set = the user decided. */
  const [cornersExpanded, setCornersExpanded] = useState<boolean | null>(null)
  const pickerSnapshot = useRef<Map<NodeId, { fills: Paint[]; strokes: Paint[]; effects: Effect[] }> | null>(null)

  const scene = documentStore.scene
  const nodes = selection.map((id) => scene.getNode(id)).filter((n): n is SceneNode => !!n)
  const panel = usePanelWidth('polyform.panel.right', 288, 'left')

  if (nodes.length === 0) {
    return (
      <div
        data-inspector
        className="shrink-0 relative bg-[var(--pf-bg-0)] border-l border-[var(--pf-border)] overflow-y-auto"
        style={{ width: panel.width }}
      >
        <ResizeHandle edge="left" dragging={panel.dragging} onPointerDown={panel.onPointerDown} title="Drag to resize the panel" />
        <StylesPanel />
        <div className="px-4 py-6 text-[11px] text-[var(--pf-text-dim)]">
          Select a layer to edit its properties.
          <div className="mt-4 space-y-1 leading-5">
            <div>V — Move · F — Frame · R — Rectangle</div>
            <div>O — Ellipse · L — Line · P — Pen · T — Text</div>
            <div>Enter — edit vector points · Shift+R — rulers</div>
            <div>Ctrl+wheel — zoom · Space — pan</div>
          </div>
        </div>
      </div>
    )
  }

  /** Corners that already differ have four values to show, so they start
   *  expanded — dragging one corner handle on canvas lands here. The toggle
   *  still wins: forcing it open made the button look broken, since collapsing
   *  had no visible effect. Collapsed, the single field reads "Mixed". */
  const cornersDiffer = nodes.some((n) => {
    const r = (n as { cornerRadius?: { tl: number; tr: number; br: number; bl: number } }).cornerRadius
    return r ? !(r.tl === r.tr && r.tr === r.br && r.br === r.bl) : false
  })
  const showCorners = cornersExpanded ?? cornersDiffer

  const first = nodes[0]

  // Every selected node must be able to carry an alignment for the control to mean
  // anything: with a line in the selection, "Outside" would apply to some and be
  // silently ignored on the rest.
  const alignApplies = nodes.every((n) => strokeAlignApplies(n))

  const common = <T,>(get: (n: SceneNode) => T): T | null => {
    const v = get(first)
    const s = JSON.stringify(v)
    return nodes.every((n) => JSON.stringify(get(n)) === s) ? v : null
  }

  const commit = (patchFor: (n: SceneNode) => Record<string, unknown> | null, label: string) =>
    updateSelectedNodes(patchFor, label)

  // ------------------------------------------------------------------
  // Paint editing with live preview + single history commit on close
  // ------------------------------------------------------------------

  const openPicker = (state: PickerState) => {
    pickerSnapshot.current = new Map(
      selectedIds().map((id) => {
        const n = scene.requireNode(id)
        return [id, structuredClone({ fills: n.fills, strokes: n.strokes, effects: n.effects })]
      }),
    )
    setPicker(state)
  }

  const closePicker = () => {
    if (picker && pickerSnapshot.current) {
      const ops: PatchOp[] = []
      for (const [id, before] of pickerSnapshot.current) {
        const n = scene.getNode(id)
        if (!n) continue
        const after = { fills: n.fills, strokes: n.strokes, effects: n.effects }
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          ops.push({
            kind: 'update',
            id,
            before: structuredClone(before) as Record<string, unknown>,
            after: structuredClone(after) as Record<string, unknown>,
          })
        }
      }
      if (ops.length > 0) documentStore.commit(ops, 'Edit Paint', true)
    }
    pickerSnapshot.current = null
    setPicker(null)
  }

  const livePaintColor = (c: RGBA) => {
    if (!picker) return
    for (const id of selectedIds()) {
      const n = scene.getNode(id)
      if (!n) continue
      if (picker.kind === 'effect') {
        const fx = n.effects[picker.index]
        if (fx && (fx.type === 'DROP_SHADOW' || fx.type === 'INNER_SHADOW')) fx.color = { ...c }
        continue
      }
      const list = picker.kind === 'fill' ? n.fills : n.strokes
      const paint = list[picker.index]
      if (!paint) continue
      if (paint.type === 'SOLID') {
        paint.color = { ...c }
      } else if ((paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL') && picker.stopIndex !== undefined) {
        const stop = paint.stops[picker.stopIndex]
        if (stop) stop.color = { ...c }
      }
    }
    scene.bump()
    documentStore.transient()
  }

  const pickerColor = ((): RGBA => {
    if (!picker) return { r: 0, g: 0, b: 0, a: 1 }
    if (picker.kind === 'effect') {
      const fx = first.effects[picker.index]
      return fx && (fx.type === 'DROP_SHADOW' || fx.type === 'INNER_SHADOW') ? fx.color : { r: 0, g: 0, b: 0, a: 1 }
    }
    const list = picker.kind === 'fill' ? first.fills : first.strokes
    const paint = list[picker.index]
    if (!paint) return { r: 0, g: 0, b: 0, a: 1 }
    if (paint.type === 'SOLID') return paint.color
    if (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL') {
      return paint.stops[picker.stopIndex ?? 0]?.color ?? { r: 0, g: 0, b: 0, a: 1 }
    }
    return { r: 0.5, g: 0.5, b: 0.5, a: 1 }
  })()

  /** The paint type the picker should offer to switch, if any. */
  const pickerPaintType = ((): PickerPaintType | undefined => {
    if (!picker || picker.kind === 'effect') return undefined
    const list = picker.kind === 'fill' ? first.fills : first.strokes
    const paint = list[picker.index]
    if (!paint || paint.type === 'IMAGE') return undefined
    return paint.type
  })()

  // ------------------------------------------------------------------

  const isFrame = nodes.every((n) => n.type === 'FRAME' || n.type === 'COMPONENT')
  const isInstance = nodes.length === 1 && first.type === 'INSTANCE'
  const hasCorner = nodes.every((n) => n.type === 'RECTANGLE' || n.type === 'FRAME')
  const isText = nodes.every((n) => n.type === 'TEXT')
  const isBool = nodes.every((n) => n.type === 'BOOLEAN')
  const isEllipse = nodes.every((n) => n.type === 'ELLIPSE')
  const isPolygon = nodes.every((n) => n.type === 'POLYGON')
  const isStar = nodes.every((n) => n.type === 'STAR')
  const isModel3d = nodes.length === 1 && first.type === 'MODEL3D'

  return (
    <div
      data-inspector
      className="shrink-0 relative bg-[var(--pf-bg-0)] border-l border-[var(--pf-border)] overflow-y-auto select-none"
      style={{ width: panel.width }}
    >
      <ResizeHandle edge="left" dragging={panel.dragging} onPointerDown={panel.onPointerDown} title="Drag to resize the panel" />
      {/* Transform */}
      <Section title={nodes.length === 1 ? first.name : `${nodes.length} layers`}>
        <Field label="Alignment" className="mb-2.5">
          <div className="flex items-center justify-between">
            <button className="pf-icon-btn" title="Align left" onClick={() => alignSelection('left')}><AlignLeftIcon /></button>
            <button className="pf-icon-btn" title="Align horizontal centers" onClick={() => alignSelection('hcenter')}><AlignHCenterIcon /></button>
            <button className="pf-icon-btn" title="Align right" onClick={() => alignSelection('right')}><AlignRightIcon /></button>
            <button className="pf-icon-btn" title="Align top" onClick={() => alignSelection('top')}><AlignTopIcon /></button>
            <button className="pf-icon-btn" title="Align vertical centers" onClick={() => alignSelection('vcenter')}><AlignVCenterIcon /></button>
            <button className="pf-icon-btn" title="Align bottom" onClick={() => alignSelection('bottom')}><AlignBottomIcon /></button>
            <button className="pf-icon-btn" title="Distribute horizontally" onClick={() => distributeSelection('h')}><DistributeHIcon /></button>
            <button className="pf-icon-btn" title="Distribute vertically" onClick={() => distributeSelection('v')}><DistributeVIcon /></button>
          </div>
        </Field>

        {/* Two columns, never four. X/Y and W/H each get a full row: at 288px
            of panel, four number fields on one line left every value clipped to
            three characters ("5163", "3603" in a box that fits "516"). */}
        <Field label="Position">
          <div className="grid grid-cols-2 gap-1.5">
            <NumberInput label="X" title="X position" value={common((n) => round(n.x))} onCommit={(v) => commit(() => ({ x: v }), 'Set X')} />
            <NumberInput label="Y" title="Y position" value={common((n) => round(n.y))} onCommit={(v) => commit(() => ({ y: v }), 'Set Y')} />
          </div>
        </Field>
        <Field label="Dimensions" className="mt-2.5">
          <div className="grid grid-cols-2 gap-1.5">
            <NumberInput label="W" title="Width" value={common((n) => round(n.width))} min={0.5} onCommit={(v) => setSelectionSize('width', v)} />
            <NumberInput label="H" title="Height" value={common((n) => round(n.height))} min={0} onCommit={(v) => setSelectionSize('height', v)} />
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-2 mt-2.5">
          <Field label="Rotation">
            <NumberInput
              label={<RotationIcon />}
              title="Rotation"
              value={common((n) => round(n.rotation))}
              suffix="°"
              onCommit={(v) => commit(() => ({ rotation: v }), 'Set Rotation')}
            />
          </Field>
          <Field label="Transform" hint="Quarter-turn, or mirror about the selection's centre">
            <div className="flex items-center gap-1">
              <button className="pf-icon-btn flex-1" title="Rotate 90° right" onClick={() => rotateSelection(90)}>
                <Rotate90Icon />
              </button>
              <button className="pf-icon-btn flex-1" title="Flip horizontal (Shift+H)" onClick={() => flipSelection('h')}>
                <FlipHIcon />
              </button>
              <button className="pf-icon-btn flex-1" title="Flip vertical (Shift+V)" onClick={() => flipSelection('v')}>
                <FlipVIcon />
              </button>
            </div>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2 mt-2.5">
          {hasCorner && (
            <Field
              label="Corner radius"
              actions={
                <button
                  className={`pf-icon-btn !w-5 !h-5 ${showCorners ? 'active' : ''}`}
                  title={showCorners ? 'Use one radius for all corners' : 'Set each corner independently'}
                  aria-pressed={showCorners}
                  onClick={() => setCornersExpanded(!showCorners)}
                >
                  <CornersIcon width={12} height={12} />
                </button>
              }
            >
              {!showCorners && (
                <NumberInput
                  label={<CornerRadiusIcon />}
                  title="Corner radius"
                  // null, not NaN: null is how a field says "mixed" and shows
                  // its placeholder. NaN reached the input as a value and
                  // rendered literally — visible the moment corners differ,
                  // which the canvas handles now make routine.
                  value={common((n) => {
                    const r = (n as { cornerRadius?: { tl: number; tr: number; br: number; bl: number } }).cornerRadius
                    if (!r) return 0
                    return r.tl === r.tr && r.tr === r.br && r.br === r.bl ? round(r.tl) : null
                  })}
                  min={0}
                  onCommit={(v) => commit(() => ({ cornerRadius: { tl: v, tr: v, br: v, bl: v } }), 'Set Corner Radius')}
                />
              )}
            </Field>
          )}
        </div>

        {hasCorner && showCorners && (
          <div className="grid grid-cols-2 gap-1.5 mt-1.5">
            {CORNERS.map(({ key, Icon, label }) => (
              <NumberInput
                key={key}
                label={<Icon />}
                title={label}
                value={common((n) => round((n as unknown as { cornerRadius: Record<string, number> }).cornerRadius[key]))}
                min={0}
                onCommit={(v) =>
                  commit((n) => ({ cornerRadius: { ...(n as unknown as { cornerRadius: Record<string, number> }).cornerRadius, [key]: v } }), 'Set Corner Radius')
                }
              />
            ))}
          </div>
        )}
        {isEllipse && (
          <div className="mt-2.5">
            <div className="pf-field-head">
              <span className="pf-field-label">Arc</span>
              {!isFullEllipse(
                common((n) => (n as EllipseNode).arcSweep ?? 1) ?? 1,
                common((n) => (n as EllipseNode).arcRatio ?? 0) ?? 0,
              ) && (
                <button
                  className="pf-btn !py-0 text-[10px] bg-[var(--pf-bg-3)]"
                  title="Back to a full ellipse"
                  onClick={() =>
                    commit(() => ({ arcStart: 0, arcSweep: 1, arcRatio: 0 }), 'Reset Arc')
                  }
                >
                  Reset
                </button>
              )}
            </div>
            {/* Degrees and percent in the UI; turns and fractions in the
             * model, so the geometry math stays unit-free. */}
            <div className="grid grid-cols-3 gap-1.5">
              <Field label="Start">
                <NumberInput
                  title="Start angle"
                  suffix="°"
                  value={common((n) => round(((n as EllipseNode).arcStart ?? 0) * 360))}
                  onCommit={(v) => commit(() => ({ arcStart: v / 360 }), 'Set Arc Start')}
                />
              </Field>
              <Field label="Sweep">
                <NumberInput
                  title="How much of the ellipse the arc covers"
                  suffix="%"
                  value={common((n) => round(((n as EllipseNode).arcSweep ?? 1) * 100))}
                  min={-100}
                  max={100}
                  onCommit={(v) => commit(() => ({ arcSweep: v / 100 }), 'Set Arc Sweep')}
                />
              </Field>
              <Field label="Inner" hint="Inner radius — above 0 makes a donut">
                <NumberInput
                  title="Inner radius (donut)"
                  suffix="%"
                  value={common((n) => round(((n as EllipseNode).arcRatio ?? 0) * 100))}
                  min={0}
                  max={99}
                  onCommit={(v) => commit(() => ({ arcRatio: v / 100 }), 'Set Arc Ratio')}
                />
              </Field>
            </div>
          </div>
        )}
        {(isPolygon || isStar) && (
          <div className="grid grid-cols-2 gap-2 mt-2.5">
            <Field label="Points">
              <NumberInput
                title="Number of points"
                value={common((n) => (n as { pointCount: number }).pointCount)}
                min={3}
                max={60}
                onCommit={(v) => commit(() => ({ pointCount: Math.round(v) }), 'Set Points')}
              />
            </Field>
            {isStar && (
              <Field label="Inner radius">
                <NumberInput
                  title="How deep the notches cut in"
                  suffix="%"
                  value={common((n) => round((n as { innerRatio: number }).innerRatio * 100))}
                  min={1}
                  max={100}
                  onCommit={(v) => commit(() => ({ innerRatio: v / 100 }), 'Set Inner Radius')}
                />
              </Field>
            )}
          </div>
        )}
        {isBool && (
          <Field label="Operation" className="mt-2.5">
            <Select<BooleanOp>
              value={(common((n) => (n as { booleanOp: BooleanOp }).booleanOp) ?? '') as BooleanOp | ''}
              options={[
                { value: 'UNION', label: 'Union' },
                { value: 'SUBTRACT', label: 'Subtract' },
                { value: 'INTERSECT', label: 'Intersect' },
                { value: 'EXCLUDE', label: 'Exclude' },
              ]}
              onChange={(v) => commit(() => ({ booleanOp: v }), 'Set Boolean Operation')}
            />
          </Field>
        )}
      </Section>

      {/* Vector points — only while a path is open for editing. */}
      {vectorEditId && first.type === 'VECTOR' && <VectorPointSection node={first} />}

      {/* 3D model (v0.5, ADR-020) */}
      {isModel3d && first.type === 'MODEL3D' && (
        <Section title="3D Model">
          <Model3dSection node={first} />
        </Section>
      )}

      {/* Instance */}
      {isInstance && first.type === 'INSTANCE' && (
        <Section title="Instance">
          <InstanceSection instance={first} />
        </Section>
      )}

      {/* Constraints (children of plain frames) */}
      {nodes.every((n) => {
        const p = scene.parentOf(n.id)
        const parent = p && !scene.isPage(p) ? scene.getNode(p) : null
        return (
          (parent?.type === 'FRAME' || parent?.type === 'COMPONENT' || parent?.type === 'INSTANCE') &&
          parent.layout.mode === 'NONE'
        )
      }) && (
        <Section title="Constraints">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Horizontal" hint="What this layer keeps fixed when its frame is resized">
              <Select<Constraint>
                value={(common((n) => n.constraintsH ?? 'MIN') ?? '') as Constraint | ''}
                options={[
                  { value: 'MIN', label: 'Left' },
                  { value: 'MAX', label: 'Right' },
                  { value: 'CENTER', label: 'Center' },
                  { value: 'STRETCH', label: 'Left & right' },
                  { value: 'SCALE', label: 'Scale' },
                ]}
                onChange={(v) => commit(() => ({ constraintsH: v }), 'Set Constraints')}
              />
            </Field>
            <Field label="Vertical">
              <Select<Constraint>
                value={(common((n) => n.constraintsV ?? 'MIN') ?? '') as Constraint | ''}
                options={[
                  { value: 'MIN', label: 'Top' },
                  { value: 'MAX', label: 'Bottom' },
                  { value: 'CENTER', label: 'Center' },
                  { value: 'STRETCH', label: 'Top & bottom' },
                  { value: 'SCALE', label: 'Scale' },
                ]}
                onChange={(v) => commit(() => ({ constraintsV: v }), 'Set Constraints')}
              />
            </Field>
          </div>
        </Section>
      )}

      {/* Auto layout */}
      {isFrame && (
        <Section title="Auto layout">
          <AutoLayoutEditor frame={first as FrameNode} commit={commit} common={common} />
        </Section>
      )}

      {/* Appearance */}
      <Section title="Appearance">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Opacity">
            <NumberInput
              label={<OpacityIcon />}
              title="Layer opacity"
              value={common((n) => round(n.opacity * 100))}
              min={0}
              max={100}
              suffix="%"
              onCommit={(v) => commit(() => ({ opacity: v / 100 }), 'Set Opacity')}
            />
          </Field>
          <Field label="Blend mode">
            <Select<BlendMode>
              value={(common((n) => n.blendMode) ?? '') as BlendMode | ''}
              options={BLEND_OPTIONS}
              onChange={(v) => commit(() => ({ blendMode: v }), 'Set Blend Mode')}
            />
          </Field>
        </div>
        {nodes.every((n) => n.type !== 'FRAME') && (
          <label className="flex items-center gap-2 mt-2 text-[11px] text-[var(--pf-text-dim)] cursor-default">
            <input
              type="checkbox"
              checked={common((n) => n.isMask ?? false) === true}
              onChange={() => toggleMaskSelection()}
            />
            Use as mask (clips siblings above)
          </label>
        )}
      </Section>

      {/* Text */}
      {isText && (
        <Section title="Text">
          <TextStyleChip node={first as TextNode} />
          <TextEditor node={first as TextNode} fonts={fonts} commit={commit} common={common} />
        </Section>
      )}

      {/* Fills */}
      <Section
        title="Fill"
        actions={
          <button
            className="pf-icon-btn !w-5 !h-5"
            title="Add fill"
            onClick={() => commit((n) => ({ fills: [...structuredClone(n.fills), solid({ r: 0.85, g: 0.85, b: 0.85, a: 1 })] }), 'Add Fill')}
          >
            <PlusIcon width={12} height={12} />
          </button>
        }
      >
        <FillStyleChip node={first} />
        {first.fills.length === 0 && <div className="text-[11px] text-[var(--pf-text-dim)]">No fill</div>}
        {first.fills.map((paint, i) => (
          <div key={i}>
            <PaintRow
              paint={paint}
              box={fillPaintBox(first)}
              onSwatch={(anchor, stopIndex) => openPicker({ kind: 'fill', index: i, anchor, stopIndex })}
              onToggle={() =>
                commit((n) => {
                  const fills = structuredClone(n.fills)
                  if (fills[i]) fills[i].visible = !fills[i].visible
                  return { fills }
                }, 'Toggle Fill')
              }
              onRemove={() =>
                commit((n) => {
                  const fills = structuredClone(n.fills)
                  fills.splice(i, 1)
                  return { fills }
                }, 'Remove Fill')
              }
              onTypeChange={(t) =>
                commit((n) => {
                  const fills = structuredClone(n.fills)
                  fills[i] = convertPaintType(fills[i], t)
                  return { fills }
                }, 'Change Fill Type')
              }
              onScaleModeChange={(mode) =>
                commit((n) => {
                  const fills = structuredClone(n.fills)
                  const p = fills[i]
                  if (p && p.type === 'IMAGE') p.scaleMode = mode
                  return { fills }
                }, 'Set Image Fit')
              }
              onStopsChange={(mutate) =>
                commit((n) => {
                  const fills = structuredClone(n.fills)
                  const p = fills[i]
                  if (p && (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL')) mutate(p)
                  return { fills }
                }, 'Edit Gradient')
              }
            />
            {paint.type === 'IMAGE' && (
              <ImageFillControls
                paint={paint}
                nodeId={first.id}
                fillIndex={i}
                onChange={(mutate, label) =>
                  commit((n) => {
                    const fills = structuredClone(n.fills)
                    const p = fills[i]
                    if (p && p.type === 'IMAGE') mutate(p)
                    return { fills }
                  }, label)
                }
              />
            )}
          </div>
        ))}
      </Section>

      {/* Strokes */}
      <Section
        title="Stroke"
        actions={
          <button
            className="pf-icon-btn !w-5 !h-5"
            title="Add stroke"
            onClick={() => commit((n) => ({ strokes: n.strokes.length ? n.strokes : [solid({ r: 0, g: 0, b: 0, a: 1 })] }), 'Add Stroke')}
          >
            <PlusIcon width={12} height={12} />
          </button>
        }
      >
        {first.strokes.length === 0 && <div className="text-[11px] text-[var(--pf-text-dim)]">No stroke</div>}
        {first.strokes.map((paint, i) => (
          <PaintRow
            key={i}
            paint={paint}
            box={strokePaintBox(first)}
          onSwatch={(anchor, stopIndex) => openPicker({ kind: 'stroke', index: i, anchor, stopIndex })}
            onToggle={() =>
              commit((n) => {
                const strokes = structuredClone(n.strokes)
                if (strokes[i]) strokes[i].visible = !strokes[i].visible
                return { strokes }
              }, 'Toggle Stroke')
            }
            onRemove={() =>
              commit((n) => {
                const strokes = structuredClone(n.strokes)
                strokes.splice(i, 1)
                return { strokes }
              }, 'Remove Stroke')
            }
            onTypeChange={(t) =>
              commit((n) => {
                const strokes = structuredClone(n.strokes)
                strokes[i] = convertPaintType(strokes[i], t)
                return { strokes }
              }, 'Change Stroke Type')
            }
            // Without this the gradient editor did not exist for STROKES at all:
            // PaintRow gates the stops bar and the direction control on it, and only
            // the fill row was passing one. So a gradient stroke could be created and
            // never edited — no stops, no angle — which is exactly the gradient most
            // people meet first on a line.
            onStopsChange={(mutate) =>
              commit((n) => {
                const strokes = structuredClone(n.strokes)
                const p = strokes[i]
                if (p && (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL')) mutate(p)
                return { strokes }
              }, 'Edit Gradient')
            }
          />
        ))}
        {first.strokes.length > 0 && (
          <div className="grid grid-cols-3 gap-1.5 mt-2.5">
            <Field label="Weight">
              <NumberInput
                label={<StrokeWeightIcon />}
                title="Stroke weight"
                value={common((n) => round(n.strokeWeight))}
                min={0}
                onCommit={(v) => commit(() => ({ strokeWeight: v }), 'Set Stroke Weight')}
              />
            </Field>
            {/* Alignment needs an interior. A line has none, and neither does an
                open path, so both renderers draw those centred whatever is stored —
                which made this control a place to pick a value nothing read, and
                then see it displayed as if it had taken effect. Disabled, showing
                Center, with the reason in the hint. */}
            <Field
              label="Align"
              hint={
                alignApplies
                  ? 'Which side of the path the stroke sits on'
                  : 'Only closed shapes have an inside — an open path is always centred'
              }
            >
              <Select
                value={
                  alignApplies ? ((common((n) => n.strokeAlign) ?? '') as 'CENTER' | 'INSIDE' | 'OUTSIDE' | '') : 'CENTER'
                }
                disabled={!alignApplies}
                options={[
                  { value: 'INSIDE', label: 'Inside' },
                  { value: 'CENTER', label: 'Center' },
                  { value: 'OUTSIDE', label: 'Outside' },
                ]}
                onChange={(v) => commit(() => ({ strokeAlign: v }), 'Set Stroke Align')}
              />
            </Field>
            <Field label="Style">
              <Select
                value={common((n) => (n.strokeDash.length > 0 ? 'dash' : 'solid')) ?? ''}
                options={[
                  { value: 'solid', label: 'Solid' },
                  { value: 'dash', label: 'Dashed' },
                ]}
                onChange={(v) => commit((n) => ({ strokeDash: v === 'dash' ? [n.strokeWeight * 3, n.strokeWeight * 3] : [] }), 'Set Dash')}
              />
            </Field>
          </div>
        )}
      </Section>

      {/* Effects */}
      <Section
        title="Effects"
        actions={
          <button
            className="pf-icon-btn !w-5 !h-5"
            title="Add effect"
            onClick={() =>
              commit(
                (n) => ({
                  effects: [
                    ...structuredClone(n.effects),
                    { type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, blur: 8 } as Effect,
                  ],
                }),
                'Add Effect',
              )
            }
          >
            <PlusIcon width={12} height={12} />
          </button>
        }
      >
        {first.effects.length === 0 && <div className="text-[11px] text-[var(--pf-text-dim)]">No effects</div>}
        {first.effects.map((fx, i) => (
          <div key={i} className="mb-2">
            <div className="flex items-center gap-1.5">
              <Select
                value={fx.type}
                options={[
                  { value: 'DROP_SHADOW', label: 'Drop shadow' },
                  { value: 'INNER_SHADOW', label: 'Inner shadow' },
                  { value: 'LAYER_BLUR', label: 'Layer blur' },
                  { value: 'BACKGROUND_BLUR', label: 'Background blur' },
                ]}
                onChange={(t) =>
                  commit((n) => {
                    const effects = structuredClone(n.effects)
                    effects[i] =
                      t === 'DROP_SHADOW'
                        ? { type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, blur: 8 }
                        : t === 'INNER_SHADOW'
                          ? { type: 'INNER_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.3 }, offset: { x: 0, y: 2 }, blur: 6 }
                          : t === 'LAYER_BLUR'
                            ? { type: 'LAYER_BLUR', visible: true, radius: 4 }
                            : { type: 'BACKGROUND_BLUR', visible: true, radius: 10 }
                    return { effects }
                  }, 'Change Effect')
                }
                className="flex-1"
              />
              <button
                className="pf-icon-btn !w-5 !h-5"
                onClick={() =>
                  commit((n) => {
                    const effects = structuredClone(n.effects)
                    if (effects[i]) effects[i].visible = !effects[i].visible
                    return { effects }
                  }, 'Toggle Effect')
                }
              >
                {fx.visible ? <EyeIcon width={11} height={11} /> : <EyeOffIcon width={11} height={11} />}
              </button>
              <button
                className="pf-icon-btn !w-5 !h-5"
                onClick={() =>
                  commit((n) => {
                    const effects = structuredClone(n.effects)
                    effects.splice(i, 1)
                    return { effects }
                  }, 'Remove Effect')
                }
              >
                <MinusIcon width={11} height={11} />
              </button>
            </div>
            {(fx.type === 'DROP_SHADOW' || fx.type === 'INNER_SHADOW') && (
              <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-1.5 mt-1.5 items-end">
                <Field label="Offset X">
                  <NumberInput title="Horizontal offset" value={round(fx.offset.x)} onCommit={(v) => commit((n) => patchEffect(n, i, (e) => (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') && (e.offset = { ...e.offset, x: v })), 'Set Shadow')} />
                </Field>
                <Field label="Y">
                  <NumberInput title="Vertical offset" value={round(fx.offset.y)} onCommit={(v) => commit((n) => patchEffect(n, i, (e) => (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') && (e.offset = { ...e.offset, y: v })), 'Set Shadow')} />
                </Field>
                <Field label="Blur">
                  <NumberInput title="Shadow blur" value={round(fx.blur)} min={0} onCommit={(v) => commit((n) => patchEffect(n, i, (e) => (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') && (e.blur = v)), 'Set Shadow')} />
                </Field>
                <Field label="Color">
                  <button
                    className="pf-swatch !w-[26px] !h-[26px]"
                    style={{ background: rgbaToCss(fx.color) }}
                    title="Shadow colour"
                    onClick={(e) => {
                      openPicker({ kind: 'effect', index: i, anchor: popoverAnchor(e.currentTarget as HTMLElement) })
                    }}
                  />
                </Field>
              </div>
            )}
            {(fx.type === 'LAYER_BLUR' || fx.type === 'BACKGROUND_BLUR') && (
              <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                <Field label="Radius" hint={fx.type === 'BACKGROUND_BLUR' ? 'How far the blur reaches behind this layer' : 'How far the blur reaches'}>
                  <NumberInput label={<BlurIcon />} title="Blur radius" value={round(fx.radius)} min={0} onCommit={(v) => commit((n) => patchEffect(n, i, (e) => (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') && (e.radius = v)), 'Set Blur')} />
                </Field>
              </div>
            )}
          </div>
        ))}
      </Section>

      {/* Export */}
      <ExportSection targetName={nodes.length === 1 ? first.name : `${nodes.length} layers`} />

      {picker && (
        <ColorPicker
          color={pickerColor}
          anchor={picker.anchor}
          onLive={livePaintColor}
          onClose={closePicker}
          // Paint type and shared styles only make sense for fills and
          // strokes — an effect's colour is just a colour.
          paintType={pickerPaintType}
          onPaintType={
            pickerPaintType
              ? (t) => {
                  const kind = picker.kind
                  const i = picker.index
                  commit((n) => {
                    const list = structuredClone(kind === 'fill' ? n.fills : n.strokes)
                    if (list[i]) list[i] = convertPaintType(list[i], t)
                    return kind === 'fill' ? { fills: list } : { strokes: list }
                  }, 'Change Paint Type')
                }
              : undefined
          }
          onApplyStyle={
            picker.kind === 'fill' ? (id) => applyColorStyle(id) : undefined
          }
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * The selected point(s) of an open path: how each ties its two handles
 * together. Per point, because that is where the choice belongs — one corner in
 * an otherwise smooth curve is the normal case, not the exception.
 */
function VectorPointSection({ node }: { node: VectorNode }) {
  const points = useEditor((s) => s.vectorSelection)
  const chosen = points
    .map((id) => node.network.vertices.find((v) => v.id === id))
    .filter((v): v is VectorNode['network']['vertices'][number] => !!v)

  if (chosen.length === 0) {
    return (
      <Section title="Point">
        <div className="text-[11px] text-[var(--pf-text-dim)] leading-relaxed">
          Click a point on the path to edit it. Drag a segment in Bend mode to curve it.
        </div>
      </Section>
    )
  }

  const modes = new Set(chosen.map((v) => v.mirror ?? 'NONE'))
  const current = modes.size === 1 ? [...modes][0] : null

  const radii = new Set(chosen.map((v) => round(v.cornerRadius ?? 0)))
  const radius = radii.size === 1 ? [...radii][0] : null

  /** Points whose fillet the outline will actually draw (see roundSubPathCorners). */
  const roundable = chosen.filter((v) => {
    const touching = node.network.edges.filter((e) => e.v0 === v.id || e.v1 === v.id)
    return touching.length >= 2 && touching.every((e) => e.cp0 === null && e.cp1 === null)
  })

  /** Mutate the network in place, then commit it as one entry. */
  const commitNetwork = (mutate: () => void, label: string) => {
    const before = structuredClone(node.network)
    mutate()
    documentStore.scene.bump()
    documentStore.commit(
      [
        {
          kind: 'update',
          id: node.id,
          before: { network: before },
          after: { network: structuredClone(node.network) },
        },
      ],
      label,
      true,
    )
  }

  const apply = (mode: MirrorMode) => {
    commitNetwork(() => {
      for (const v of chosen) setVertexMirror(node.network, v.id, mode)
    }, 'Set Point Mirroring')
  }

  const applyRadius = (value: number) => {
    const r = Math.max(0, value)
    commitNetwork(() => {
      for (const v of chosen) {
        const target = node.network.vertices.find((x) => x.id === v.id)
        if (!target) continue
        // Drop the field rather than storing a 0: absent is the same thing, and
        // it keeps a document that never rounds anything free of the noise.
        if (r === 0) delete target.cornerRadius
        else target.cornerRadius = r
      }
    }, 'Set Point Radius')
  }

  return (
    <Section title={chosen.length === 1 ? 'Point' : `${chosen.length} points`}>
      <Field label="Mirroring" hint="What the opposite handle does when you drag one">
        <Segmented<MirrorMode>
          value={current}
          options={[
            { value: 'NONE', label: <MirrorNoneIcon width={13} height={13} />, title: 'No mirroring — each handle is independent' },
            { value: 'ANGLE', label: <MirrorAngleIcon width={13} height={13} />, title: 'Mirror the angle — the other handle keeps its own length' },
            { value: 'ANGLE_LENGTH', label: <MirrorFullIcon width={13} height={13} />, title: 'Mirror angle and length — both arms stay equal' },
          ]}
          onChange={apply}
        />
      </Field>
      <Field
        label="Corner radius"
        hint="Rounds the corner at this point, cutting back along both segments"
        className="mt-2"
      >
        <NumberInput
          label={<CornerRadiusIcon />}
          title="Corner radius at this point"
          value={radius}
          min={0}
          onCommit={applyRadius}
        />
      </Field>
      <div className="text-[10px] text-[var(--pf-text-dim)] mt-2 leading-relaxed">
        {roundable.length === 0
          ? 'A point between curved segments stays sharp — the radius is kept, and applies if you straighten them.'
          : roundable.length < chosen.length
            ? `${chosen.length - roundable.length} of these sit next to a curve and stay sharp.`
            : 'The radius is capped at half the shorter segment. Hold Alt while dragging a handle to break the pairing just for that drag.'}
      </div>
    </Section>
  )
}

const SCALES = [0.5, 1, 2, 3, 4]

/** The next target that doesn't collide with one already listed, or null. */
function nextExportTarget(targets: ExportTarget[]): ExportTarget | null {
  for (const scale of [2, 1, 3, 4, 0.5]) {
    if (!targets.some((t) => t.format === 'png' && t.scale === scale)) return { format: 'png', scale }
  }
  if (!targets.some((t) => t.format === 'svg')) return { format: 'svg', scale: 1 }
  return null
}

/**
 * Export targets, added one at a time.
 *
 * Empty until you add something, because a layer usually isn't being exported —
 * and one layer often needs several files at once (a 1x and a 2x PNG, or a PNG
 * beside an SVG), which a single pair of format buttons can't express. Rows are
 * per-panel rather than stored on the layer; keeping them in the document is a
 * schema change, and this pass is about clarity.
 */
function ExportSection({ targetName }: { targetName: string }) {
  const [targets, setTargets] = useState<ExportTarget[]>([])
  const [busy, setBusy] = useState(false)
  const addable = nextExportTarget(targets)

  return (
    <Section
      title="Export"
      actions={
        <button
          className="pf-icon-btn !w-5 !h-5"
          title={addable ? 'Add an export target' : 'Every size and format is already listed'}
          disabled={!addable}
          onClick={() => addable && setTargets((prev) => [...prev, addable])}
        >
          <PlusIcon width={12} height={12} />
        </button>
      }
    >
      {targets.length > 0 && (
        <>
          <div className="flex flex-col gap-1.5">
            {/* Explicit grid columns: both selects carry pf-input's w-full, so
                in a flex row the first one ate the whole width. */}
            {targets.map((t, i) => (
              <div key={`${t.format}-${t.scale}-${i}`} className="grid grid-cols-[4.25rem_1fr_auto] items-center gap-1.5">
                <Select
                  // SVG is resolution-independent, so a scale would be a lie.
                  value={t.format === 'svg' ? '1' : String(t.scale)}
                  options={SCALES.map((s) => ({ value: String(s), label: `${s}x` }))}
                  onChange={(v) =>
                    setTargets((prev) => prev.map((p, j) => (j === i ? { ...p, scale: parseFloat(v) } : p)))
                  }
                  disabled={t.format === 'svg'}
                />
                <Select
                  value={t.format}
                  options={[
                    { value: 'png', label: 'PNG' },
                    { value: 'svg', label: 'SVG' },
                  ]}
                  onChange={(v) =>
                    setTargets((prev) => prev.map((p, j) => (j === i ? { ...p, format: v as 'png' | 'svg' } : p)))
                  }
                />
                <button
                  className="pf-icon-btn !w-5 !h-5"
                  title="Remove this target"
                  onClick={() => setTargets((prev) => prev.filter((_, j) => j !== i))}
                >
                  <MinusIcon width={11} height={11} />
                </button>
              </div>
            ))}
          </div>
          <button
            className="pf-btn w-full mt-2 bg-[var(--pf-bg-3)] gap-1.5"
            disabled={busy}
            title={
              targets.length > 1
                ? 'Pick one folder; every target is written into it'
                : 'Choose where to save it'
            }
            onClick={() => {
              setBusy(true)
              void runExports(targets).finally(() => setBusy(false))
            }}
          >
            <ExportIcon width={12} height={12} />
            {busy ? 'Exporting…' : `Export ${targetName}`}
          </button>
        </>
      )}
    </Section>
  )
}

function patchEffect(n: SceneNode, i: number, mutate: (e: Effect) => unknown): Record<string, unknown> {
  const effects = structuredClone(n.effects)
  if (effects[i]) mutate(effects[i])
  return { effects }
}

function convertPaintType(paint: Paint, type: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL'): Paint {
  if (paint.type === type) return paint
  const baseColor: RGBA =
    paint.type === 'SOLID'
      ? paint.color
      : paint.type === 'IMAGE'
        ? { r: 0.5, g: 0.5, b: 0.5, a: 1 }
        : (paint.stops[0]?.color ?? { r: 0.5, g: 0.5, b: 0.5, a: 1 })
  if (type === 'SOLID') {
    return { type: 'SOLID', visible: paint.visible, opacity: paint.opacity, color: baseColor }
  }
  return {
    type,
    visible: paint.visible,
    opacity: paint.opacity,
    stops:
      paint.type !== 'SOLID' && paint.type !== 'IMAGE'
        ? paint.stops
        : [
            { position: 0, color: baseColor },
            { position: 1, color: { ...baseColor, a: 0 } },
          ],
    start: type === 'GRADIENT_RADIAL' ? { x: 0.5, y: 0.5 } : { x: 0.5, y: 0 },
    end: type === 'GRADIENT_RADIAL' ? { x: 1, y: 0.5 } : { x: 0.5, y: 1 },
  }
}

function paintSwatchCss(paint: Paint): string {
  if (paint.type === 'SOLID') return rgbaToCss(paint.color)
  if (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL') {
    const stops = paint.stops.map((s) => `${rgbaToCss(s.color)} ${s.position * 100}%`).join(', ')
    return paint.type === 'GRADIENT_LINEAR' ? `linear-gradient(180deg, ${stops})` : `radial-gradient(circle, ${stops})`
  }
  return 'repeating-conic-gradient(#666 0 25%, #999 0 50%) 0 0 / 8px 8px'
}

/**
 * Where a popover opened from the inspector belongs: clear of the WHOLE PANEL, not
 * of the little swatch that opened it.
 *
 * Measuring from the swatch looks right and is off by the panel's padding — the
 * picker's edge landed three pixels over the panel border, which is exactly the kind
 * of "nearly" that reads as a bug. The panel's own left edge is the boundary that
 * matters, so the row you are editing stays readable while you pick.
 */
function popoverAnchor(el: HTMLElement): { x: number; y: number } {
  const own = el.getBoundingClientRect()
  const panel = el.closest('[data-inspector]')?.getBoundingClientRect()
  return { x: panel ? panel.left : own.left, y: own.top }
}

function PaintRow({
  paint,
  onSwatch,
  onToggle,
  onRemove,
  onTypeChange,
  onScaleModeChange,
  onStopsChange,
  box,
}: {
  paint: Paint
  /**
   * The box this paint is painted through — the node's own for a fill, the band the
   * stroke covers for a stroke. The direction control needs it to report an angle
   * that matches the pixels rather than one in unit space (paintbox.ts).
   */
  box: PaintBox
  onSwatch: (anchor: { x: number; y: number }, stopIndex?: number) => void
  onToggle: () => void
  onRemove: () => void
  onTypeChange: (t: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL') => void
  onScaleModeChange?: (m: 'FILL' | 'FIT' | 'TILE' | 'STRETCH') => void
  onStopsChange?: (mutate: (p: GradientPaint) => void) => void
}) {
  const isGradient = paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL'
  return (
    <div className="mb-1.5">
      <div className="flex items-center gap-1.5">
        <button
          className="w-6 h-6 rounded border border-[var(--pf-border)] shrink-0"
          style={{ background: paintSwatchCss(paint) }}
          onClick={(e) => {
            onSwatch(popoverAnchor(e.currentTarget as HTMLElement), isGradient ? 0 : undefined)
          }}
        />
        {paint.type === 'IMAGE' ? (
          <Select
            value={paint.scaleMode}
            options={[
              { value: 'FILL', label: 'Fill' },
              { value: 'FIT', label: 'Fit' },
              { value: 'TILE', label: 'Tile' },
              { value: 'STRETCH', label: 'Stretch' },
            ]}
            onChange={(v) => onScaleModeChange?.(v)}
            className="flex-1"
          />
        ) : (
          <Select
            value={paint.type}
            options={[
              { value: 'SOLID', label: paint.type === 'SOLID' ? rgbaToHex(paint.color) : 'Solid' },
              { value: 'GRADIENT_LINEAR', label: 'Linear' },
              { value: 'GRADIENT_RADIAL', label: 'Radial' },
            ]}
            onChange={(v) => onTypeChange(v as 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL')}
            className="flex-1"
          />
        )}
        <button className="pf-icon-btn !w-5 !h-5" onClick={onToggle} title={paint.visible ? 'Hide' : 'Show'}>
          {paint.visible ? <EyeIcon width={11} height={11} /> : <EyeOffIcon width={11} height={11} />}
        </button>
        <button className="pf-icon-btn !w-5 !h-5" onClick={onRemove} title="Remove">
          <MinusIcon width={11} height={11} />
        </button>
      </div>
      {(paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL') && onStopsChange && (
        <>
          <GradientStopsBar paint={paint} onSwatch={onSwatch} onStopsChange={onStopsChange} />
          {paint.type === 'GRADIENT_LINEAR' && (
            <GradientDirection paint={paint} box={box} onGradientChange={onStopsChange} />
          )}
        </>
      )}
    </div>
  )
}

/**
 * Which way a linear gradient runs, as a number you can type.
 *
 * A gradient was previously only editable by its stops: the direction was whatever
 * the file happened to contain (or straight down, for one made here), with no way to
 * turn it. The angle shown is the angle ON SCREEN — 0° left to right, 90° top to
 * bottom — computed through the paint box, because unit space is not square and
 * "45°" in a 600×40 band points nowhere near 45°.
 */
function GradientDirection({
  paint,
  box,
  onGradientChange,
}: {
  paint: GradientPaint
  box: PaintBox
  onGradientChange: (mutate: (p: GradientPaint) => void) => void
}) {
  const angle = Math.round(gradientAngle(paint, box))
  const setAngle = (deg: number) =>
    onGradientChange((p) => {
      const turned = withGradientAngle(p, box, deg)
      p.start = turned.start
      p.end = turned.end
    })
  return (
    <div className="flex items-center gap-1.5 mt-1.5 ml-8">
      <NumberInput
        label={<RotationIcon />}
        title="Gradient angle — 0° runs left to right, 90° top to bottom"
        value={angle}
        suffix="°"
        onCommit={setAngle}
        className="flex-1"
      />
      <button className="pf-icon-btn !w-6 !h-6" title="Turn 90°" onClick={() => setAngle(angle + 90)}>
        <Rotate90Icon width={11} height={11} />
      </button>
      <button
        className="pf-icon-btn !w-6 !h-6"
        title="Reverse the stops"
        onClick={() =>
          onGradientChange((p) => {
            // Mirror the positions and re-sort, so the ramp reads the other way while
            // the direction stays put — reversing by swapping start/end would rotate
            // the gradient 180° instead, which is a different operation.
            p.stops = p.stops.map((s) => ({ ...s, position: 1 - s.position })).sort((a, b) => a.position - b.position)
          })
        }
      >
        <SwapIcon width={11} height={11} />
      </button>
    </div>
  )
}

/**
 * Gradient stop editor: drag stops along the bar, click to recolor,
 * double-click the bar to add a stop, Alt+click a stop to remove it.
 */
function GradientStopsBar({
  paint,
  onSwatch,
  onStopsChange,
}: {
  paint: GradientPaint
  onSwatch: (anchor: { x: number; y: number }, stopIndex: number) => void
  onStopsChange: (mutate: (p: GradientPaint) => void) => void
}) {
  const gradientCss = `linear-gradient(90deg, ${paint.stops
    .map((s) => `${rgbaToCss(s.color)} ${Math.max(0, Math.min(1, s.position)) * 100}%`)
    .join(', ')})`

  const dragStop = (e: React.PointerEvent, si: number) => {
    e.stopPropagation()
    const bar = (e.currentTarget as HTMLElement).parentElement!
    const rect = bar.getBoundingClientRect()
    let moved = false
    const onMove = (ev: PointerEvent) => {
      moved = true
      const pos = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      onStopsChange((p) => {
        if (p.stops[si]) p.stops[si].position = Math.round(pos * 100) / 100
      })
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!moved) {
        if (ev.altKey && paint.stops.length > 2) {
          onStopsChange((p) => p.stops.splice(si, 1))
        } else {
          onSwatch(popoverAnchor(e.currentTarget as HTMLElement), si)
        }
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className="relative h-4 mt-1.5 ml-8 rounded cursor-copy"
      style={{ background: gradientCss }}
      title="Double-click to add a stop · Alt+click a stop to remove"
      onDoubleClick={(e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        onStopsChange((p) => {
          // Interpolate the color at the insertion point.
          const sorted = [...p.stops].sort((a, b) => a.position - b.position)
          let color = sorted[0]?.color ?? { r: 0.5, g: 0.5, b: 0.5, a: 1 }
          for (let i = 0; i < sorted.length - 1; i++) {
            const a = sorted[i]
            const b = sorted[i + 1]
            if (pos >= a.position && pos <= b.position) {
              const t = (pos - a.position) / Math.max(1e-6, b.position - a.position)
              color = {
                r: a.color.r + (b.color.r - a.color.r) * t,
                g: a.color.g + (b.color.g - a.color.g) * t,
                b: a.color.b + (b.color.b - a.color.b) * t,
                a: a.color.a + (b.color.a - a.color.a) * t,
              }
            }
          }
          p.stops.push({ position: Math.round(pos * 100) / 100, color })
          p.stops.sort((a, b) => a.position - b.position)
        })
      }}
    >
      {paint.stops.map((stop, si) => (
        <div
          key={si}
          className="absolute top-1/2 w-3.5 h-3.5 rounded-full border-2 border-white shadow cursor-ew-resize"
          style={{
            left: `${Math.max(0, Math.min(1, stop.position)) * 100}%`,
            transform: 'translate(-50%, -50%)',
            background: rgbaToCss(stop.color),
          }}
          onPointerDown={(e) => dragStop(e, si)}
        />
      ))}
    </div>
  )
}

/** Instance controls: component link, swap, reset overrides, detach. */
/**
 * Orbit + lighting for a MODEL3D node (ADR-020). Framing is automatic, so
 * distance is a multiplier of the fit — a pose survives resizing the node
 * or swapping the asset.
 */
function Model3dSection({ node }: { node: Model3dNode }) {
  const cam = node.camera
  const splat = isSplatFormat(node.format)
  const setCam = (patch: Partial<ModelPose>, label: string) =>
    updateSelectedNodes((n) => ({ camera: { ...(n as Model3dNode).camera, ...patch } }), label)
  return (
    <div>
      <div className="text-[10px] text-[var(--pf-text-dim)] mb-2">
        {node.format}
        {splat ? ' · gaussian splats' : ' · mesh'}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Yaw" hint="Rotation around the model's up axis">
          <NumberInput title="Yaw" suffix="°" value={round(cam.yaw)} onCommit={(v) => setCam({ yaw: v }, 'Orbit Model')} />
        </Field>
        <Field label="Pitch" hint="Camera height, above or below the model">
          <NumberInput title="Pitch" suffix="°" value={round(cam.pitch)} min={-89} max={89} onCommit={(v) => setCam({ pitch: v }, 'Orbit Model')} />
        </Field>
        <Field label="Distance">
          <NumberInput title="Camera distance" value={round(cam.distance * 100) / 100} min={0.2} max={8} step={0.05} onCommit={(v) => setCam({ distance: v }, 'Zoom Model')} />
        </Field>
        <Field label="Field of view">
          <NumberInput title="Field of view" suffix="°" value={round(cam.fov)} min={5} max={110} onCommit={(v) => setCam({ fov: v }, 'Set Model FOV')} />
        </Field>
      </div>
      <button
        className="pf-btn w-full bg-[var(--pf-bg-3)] text-[10px] mt-2"
        onClick={() => updateSelectedNodes(() => ({ camera: defaultPose() }), 'Reset Model View')}
      >
        Reset view
      </button>
      {!splat && (
        <Field label="Lighting" className="mt-2">
          <Select<LightingPreset>
            value={node.lighting}
            options={[
              { value: 'STUDIO', label: 'Studio' },
              { value: 'NEUTRAL', label: 'Neutral' },
              { value: 'DRAMATIC', label: 'Dramatic' },
              { value: 'NONE', label: 'Flat' },
            ]}
            onChange={(v) => updateSelectedNodes(() => ({ lighting: v }), 'Set Model Lighting')}
          />
        </Field>
      )}
      {splat && (
        <label className="flex items-center gap-1.5 mt-2 text-[10px] cursor-pointer">
          <input
            type="checkbox"
            checked={node.upright ?? true}
            onChange={(e) => updateSelectedNodes(() => ({ upright: e.target.checked }), 'Flip Model Up Axis')}
          />
          Upright (flip captured Y axis)
        </label>
      )}
      <div className="text-[10px] text-[var(--pf-text-dim)] mt-2">
        Double-click the model on canvas to orbit it.
      </div>
    </div>
  )
}

function InstanceSection({ instance }: { instance: InstanceNode }) {
  const scene = documentStore.scene
  const comp = instance.componentId ? scene.getNode(instance.componentId) : null
  const components = listComponents(scene)
  const overrideCount = Object.keys(instance.overrides ?? {}).length
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[#a78bfa]">
          <ComponentIcon width={12} height={12} />
        </span>
        <span className="flex-1 truncate text-[11px]">
          {comp ? comp.name : '⚠ component missing (kept as-is)'}
        </span>
      </div>
      {components.length > 0 && (
        <Select
          value={comp ? instance.componentId : ''}
          options={components.map((c) => ({ value: c.id, label: c.name }))}
          onChange={(id) => swapInstanceComponent(instance.id, id)}
          className="mb-2"
        />
      )}
      <div className="flex gap-1.5">
        <button
          className="pf-btn flex-1 bg-[var(--pf-bg-3)] text-[10px]"
          disabled={overrideCount === 0}
          style={{ opacity: overrideCount === 0 ? 0.5 : 1 }}
          title={`${overrideCount} overridden layer(s)`}
          onClick={() => resetInstanceOverrides()}
        >
          Reset overrides{overrideCount > 0 ? ` (${overrideCount})` : ''}
        </button>
        <button className="pf-btn flex-1 bg-[var(--pf-bg-3)] text-[10px]" onClick={() => detachSelectedInstances()}>
          Detach
        </button>
      </div>
    </div>
  )
}

/** Image fill crop + adjustment controls (+ Remove Background, v0.4.1). */
function ImageFillControls({
  paint,
  nodeId,
  fillIndex,
  onChange,
}: {
  paint: ImagePaint
  nodeId: NodeId
  fillIndex: number
  onChange: (mutate: (p: ImagePaint) => void, label: string) => void
}) {
  const bgState = useSyncExternalStore(onBgRemoveState, bgRemoveState)
  const bgBusy = bgState.phase === 'downloading' || bgState.phase === 'loading' || bgState.phase === 'running'
  const bgLabel =
    bgState.phase === 'downloading'
      ? `Downloading model… ${bgState.pct}%`
      : bgState.phase === 'loading'
        ? 'Loading model…'
        : bgState.phase === 'running'
          ? 'Removing…'
          : 'Remove background'
  const crop = paint.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  const adj = paint.adjust ?? { exposure: 0, contrast: 0, saturation: 0 }
  const setCrop = (key: 'x' | 'y' | 'w' | 'h', v: number) =>
    onChange((p) => {
      p.crop = { ...(p.crop ?? { x: 0, y: 0, w: 1, h: 1 }), [key]: Math.max(0, Math.min(1, v / 100)) }
    }, 'Crop Image')
  const setAdj = (key: 'exposure' | 'contrast' | 'saturation', v: number) =>
    onChange((p) => {
      p.adjust = { ...(p.adjust ?? { exposure: 0, contrast: 0, saturation: 0 }), [key]: Math.max(-1, Math.min(1, v / 100)) }
    }, 'Adjust Image')
  return (
    <div className="pl-8 mb-1.5">
      <div className="flex gap-1.5 mt-1">
        <button
          className="pf-btn flex-1 bg-[var(--pf-bg-3)] text-[10px]"
          disabled={bgBusy}
          style={{ opacity: bgBusy ? 0.6 : 1 }}
          title="Cut out the subject with an on-device AI model (one-time download, fully offline afterwards)"
          onClick={() => void removeBackground(nodeId, fillIndex)}
        >
          {bgLabel}
        </button>
        {paint.originalAssetHash && (
          <button
            className="pf-btn flex-1 bg-[var(--pf-bg-3)] text-[10px]"
            disabled={bgBusy}
            title="Swap back to the image as it was before Remove Background"
            onClick={() => restoreOriginal(nodeId, fillIndex)}
          >
            Restore original
          </button>
        )}
      </div>
      {bgState.phase === 'error' && (
        <div className="text-[10px] text-[var(--pf-danger,#e66)] mt-1">{bgState.message}</div>
      )}
      <Field label="Crop" hint="Which part of the image is shown, as a percentage of it" className="mt-1.5">
        <div className="grid grid-cols-4 gap-1">
          <NumberInput label="X" title="Crop from the left" value={round(crop.x * 100)} min={0} max={100} onCommit={(v) => setCrop('x', v)} />
          <NumberInput label="Y" title="Crop from the top" value={round(crop.y * 100)} min={0} max={100} onCommit={(v) => setCrop('y', v)} />
          <NumberInput label="W" title="Cropped width" value={round(crop.w * 100)} min={1} max={100} onCommit={(v) => setCrop('w', v)} />
          <NumberInput label="H" title="Cropped height" value={round(crop.h * 100)} min={1} max={100} onCommit={(v) => setCrop('h', v)} />
        </div>
      </Field>
      <div className="grid grid-cols-3 gap-1 mt-1.5">
        <Field label="Exposure">
          <NumberInput title="Exposure, −100 to 100" value={round(adj.exposure * 100)} min={-100} max={100} onCommit={(v) => setAdj('exposure', v)} />
        </Field>
        <Field label="Contrast">
          <NumberInput title="Contrast, −100 to 100" value={round(adj.contrast * 100)} min={-100} max={100} onCommit={(v) => setAdj('contrast', v)} />
        </Field>
        <Field label="Saturation">
          <NumberInput title="Saturation, −100 to 100" value={round(adj.saturation * 100)} min={-100} max={100} onCommit={(v) => setAdj('saturation', v)} />
        </Field>
      </div>
    </div>
  )
}

/** Shared color-style chip for the Fill section. */
function FillStyleChip({ node }: { node: SceneNode }) {
  const styles = documentStore.scene.doc.styles.colors
  const ref = node.styleRefs?.fill
  const applied = ref ? styles.find((s) => s.id === ref) : null
  if (applied) {
    return (
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="w-4 h-4 rounded-full border border-[var(--pf-border)]" style={{ background: paintSwatchCss(applied.paint) }} />
        <EditableStyleName name={applied.name} onRename={(name) => renameSharedStyle('colors', applied.id, name)} />
        <button className="pf-btn !py-0.5 text-[10px] bg-[var(--pf-bg-3)]" onClick={() => detachStyle('fill')}>
          Detach
        </button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      {styles.length > 0 && (
        <Select
          value=""
          placeholder="Apply style…"
          options={styles.map((s) => ({ value: s.id, label: s.name }))}
          onChange={(id) => applyColorStyle(id)}
          className="flex-1"
        />
      )}
      {node.fills.length > 0 && (
        <button
          className="pf-btn !py-0.5 text-[10px] bg-[var(--pf-bg-3)] whitespace-nowrap"
          title="Create a shared color style from this fill (double-click its name to rename)"
          onClick={() => {
            const paint = node.fills[0]
            const name = uniqueStyleName(
              defaultColorStyleName(paint),
              styles.map((s) => s.name),
            )
            applyColorStyle(createColorStyle(name, paint))
          }}
        >
          + Style
        </button>
      )}
    </div>
  )
}

/** Shared text-style chip for the Text section. */
function TextStyleChip({ node }: { node: TextNode }) {
  const styles = documentStore.scene.doc.styles.texts
  const ref = node.styleRefs?.text
  const applied = ref ? styles.find((s) => s.id === ref) : null
  if (applied) {
    return (
      <div className="flex items-center gap-1.5 mb-2">
        <EditableStyleName name={applied.name} onRename={(name) => renameSharedStyle('texts', applied.id, name)} />
        <button className="pf-btn !py-0.5 text-[10px] bg-[var(--pf-bg-3)]" onClick={() => detachStyle('text')}>
          Detach
        </button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 mb-2">
      {styles.length > 0 && (
        <Select
          value=""
          options={styles.map((s) => ({ value: s.id, label: s.name }))}
          onChange={(id) => applyTextStyle(id)}
          className="flex-1"
        />
      )}
      <button
        className="pf-btn !py-0.5 text-[10px] bg-[var(--pf-bg-3)] whitespace-nowrap"
        title="Create a shared text style from this node (double-click its name to rename)"
        onClick={() => {
          const props = {
            fontFamily: node.fontFamily,
            fontWeight: node.fontWeight,
            italic: node.italic,
            fontSize: node.fontSize,
            lineHeight: node.lineHeight,
            letterSpacing: node.letterSpacing,
          }
          const name = uniqueStyleName(
            defaultTextStyleName(props),
            styles.map((s) => s.name),
          )
          applyTextStyle(createTextStyle(name, props))
        }}
      >
        + Style
      </button>
    </div>
  )
}

/** Document styles editor shown when nothing is selected. */
function StylesPanel() {
  const [picker, setPicker] = useState<{ styleId: string; anchor: { x: number; y: number } } | null>(null)
  const styles = documentStore.scene.doc.styles
  const liveColor = useRef<RGBA | null>(null)
  if (styles.colors.length === 0 && styles.texts.length === 0) return null

  const editing = picker ? styles.colors.find((s) => s.id === picker.styleId) : null
  const editingColor: RGBA =
    editing && editing.paint.type === 'SOLID' ? editing.paint.color : { r: 0.5, g: 0.5, b: 0.5, a: 1 }

  return (
    <>
      {styles.colors.length > 0 && (
        <Section title="Color styles">
          {styles.colors.map((s) => (
            <div key={s.id} className="group flex items-center gap-2 h-7">
              {/* The picker here writes a SOLID paint, so it must not be opened on a
                  gradient or image style: moving the wheel would flatten it. */}
              {s.paint.type === 'SOLID' ? (
                <button
                  className="w-4 h-4 rounded-full border border-[var(--pf-border)]"
                  style={{ background: paintSwatchCss(s.paint) }}
                  title="Edit color"
                  onClick={(e) => {
                    liveColor.current = null
                    setPicker({ styleId: s.id, anchor: popoverAnchor(e.currentTarget as HTMLElement) })
                  }}
                />
              ) : (
                <span
                  className="w-4 h-4 rounded-full border border-[var(--pf-border)]"
                  style={{ background: paintSwatchCss(s.paint) }}
                  title="Edit this on a layer, then make a new style — the picker here only edits solid colors"
                />
              )}
              <EditableStyleName name={s.name} onRename={(name) => renameSharedStyle('colors', s.id, name)} />
              <button
                className="hidden group-hover:block pf-icon-btn !w-5 !h-5"
                title="Delete style"
                onClick={() => deleteSharedStyle('colors', s.id)}
              >
                <MinusIcon width={11} height={11} />
              </button>
            </div>
          ))}
        </Section>
      )}
      {styles.texts.length > 0 && (
        <Section title="Text styles">
          {styles.texts.map((s) => (
            <div key={s.id} className="group flex items-center gap-2 h-7">
              <span className="text-[11px] text-[var(--pf-text-dim)]">Ag</span>
              <EditableStyleName name={s.name} onRename={(name) => renameSharedStyle('texts', s.id, name)} />
              <span className="text-[10px] text-[var(--pf-text-dim)]">
                {s.props.fontFamily} {s.props.fontSize}
              </span>
              <button
                className="hidden group-hover:block pf-icon-btn !w-5 !h-5"
                title="Delete style"
                onClick={() => deleteSharedStyle('texts', s.id)}
              >
                <MinusIcon width={11} height={11} />
              </button>
            </div>
          ))}
        </Section>
      )}
      {picker && editing && (
        <ColorPicker
          color={editingColor}
          anchor={picker.anchor}
          onLive={(c) => {
            liveColor.current = c
          }}
          onClose={() => {
            if (liveColor.current) {
              updateColorStyle(picker.styleId, { type: 'SOLID', visible: true, opacity: 1, color: liveColor.current })
            }
            setPicker(null)
          }}
        />
      )}
    </>
  )
}

function EditableStyleName({ name, onRename }: { name: string; onRename: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <input
        className="pf-input h-5 py-0 text-[11px] flex-1"
        autoFocus
        defaultValue={name}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => {
          if (e.target.value.trim() && e.target.value !== name) onRename(e.target.value.trim())
          setEditing(false)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }
  return (
    <span className="flex-1 text-[11px] truncate" onDoubleClick={() => setEditing(true)}>
      {name}
    </span>
  )
}

function AutoLayoutEditor({
  frame,
  commit,
  common,
}: {
  frame: FrameNode
  commit: (patchFor: (n: SceneNode) => Record<string, unknown> | null, label: string) => void
  common: <T>(get: (n: SceneNode) => T) => T | null
}) {
  const layoutPatch = (mutate: (l: AutoLayout) => void) => (n: SceneNode) => {
    if (n.type !== 'FRAME') return null
    const layout = structuredClone(n.layout)
    mutate(layout)
    return { layout }
  }
  const l = frame.layout
  return (
    <div>
      <Field label="Direction" hint="Stack this frame's children in a row, a column, or not at all">
        <Segmented
          value={common((n) => (n as FrameNode).layout.mode)}
          options={[
            { value: 'NONE', label: 'None', title: 'Position children freely' },
            { value: 'HORIZONTAL', label: '→', title: 'Stack in a row' },
            { value: 'VERTICAL', label: '↓', title: 'Stack in a column' },
          ]}
          onChange={(v) => commit(layoutPatch((lay) => (lay.mode = v)), 'Set Auto Layout')}
        />
      </Field>
      {l.mode !== 'NONE' && (
        <>
          <div className="grid grid-cols-2 gap-2 mt-2.5">
            <Field label="Gap" hint="Space between children">
              <NumberInput
                title="Gap between children"
                value={common((n) => (n as FrameNode).layout.gap)}
                onCommit={(v) => commit(layoutPatch((lay) => (lay.gap = v)), 'Set Gap')}
              />
            </Field>
            <Field label="Padding" hint="Space inside the frame's edges">
              <NumberInput
                title="Padding on all sides"
                value={common((n) => {
                  const lay = (n as FrameNode).layout
                  // null, not NaN — NaN reaches the input as a value and renders
                  // literally. null is how a field says "mixed".
                  return lay.paddingTop === lay.paddingRight && lay.paddingRight === lay.paddingBottom && lay.paddingBottom === lay.paddingLeft
                    ? lay.paddingTop
                    : null
                })}
                onCommit={(v) =>
                  commit(
                    layoutPatch((lay) => {
                      lay.paddingTop = lay.paddingRight = lay.paddingBottom = lay.paddingLeft = v
                    }),
                    'Set Padding',
                  )
                }
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2.5">
            <Field label="Align" hint="Where children sit across the stacking direction">
              <Select
                value={(common((n) => (n as FrameNode).layout.counterAlign) ?? '') as 'MIN' | 'CENTER' | 'MAX' | ''}
                options={[
                  { value: 'MIN', label: 'Start' },
                  { value: 'CENTER', label: 'Center' },
                  { value: 'MAX', label: 'End' },
                ]}
                onChange={(v) => commit(layoutPatch((lay) => (lay.counterAlign = v)), 'Set Alignment')}
              />
            </Field>
            <Field label="Sizing" hint="Whether the frame keeps its size or shrinks to its contents">
              <Select
                value={(common((n) => (n as FrameNode).layout.primarySizing) ?? '') as 'FIXED' | 'HUG' | ''}
                options={[
                  { value: 'FIXED', label: 'Fixed' },
                  { value: 'HUG', label: 'Hug' },
                ]}
                onChange={(v) =>
                  commit(
                    layoutPatch((lay) => {
                      lay.primarySizing = v
                      lay.counterSizing = v
                    }),
                    'Set Sizing',
                  )
                }
              />
            </Field>
          </div>
        </>
      )}
    </div>
  )
}

function TextEditor({
  node,
  fonts,
  commit,
  common,
}: {
  node: TextNode
  fonts: string[]
  commit: (patchFor: (n: SceneNode) => Record<string, unknown> | null, label: string) => void
  common: <T>(get: (n: SceneNode) => T) => T | null
}) {
  return (
    <div>
      <Field label="Font">
        <input
          className="pf-input"
          list="pf-font-list"
          defaultValue={node.fontFamily}
          key={node.id + node.fontFamily}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v && v !== node.fontFamily) commit(() => ({ fontFamily: v }), 'Set Font')
          }}
        />
      </Field>
      <datalist id="pf-font-list">
        {fonts.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5 mt-2.5 items-end">
        <Field label="Weight">
          <Select
            value={String(common((n) => (n as TextNode).fontWeight) ?? '')}
            options={[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => ({ value: String(w), label: String(w) }))}
            onChange={(v) => commit(() => ({ fontWeight: parseInt(v, 10) }), 'Set Weight')}
          />
        </Field>
        <Field label="Size">
          <NumberInput title="Font size" value={common((n) => (n as TextNode).fontSize)} min={1} onCommit={(v) => commit(() => ({ fontSize: v }), 'Set Font Size')} />
        </Field>
        <Field label="Style">
          <button
            className={`pf-btn italic h-[26px] w-8 ${node.italic ? 'bg-[var(--pf-accent-solid)] text-white' : 'bg-[#2a2a2a]'}`}
            title="Italic"
            aria-pressed={node.italic}
            onClick={() => commit((n) => ({ italic: !(n as TextNode).italic }), 'Toggle Italic')}
          >
            I
          </button>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-2.5">
        <Field label="Line height">
          <NumberInput title="Line height" value={common((n) => round((n as TextNode).lineHeight * 100))} min={50} max={400} suffix="%" onCommit={(v) => commit(() => ({ lineHeight: v / 100 }), 'Set Line Height')} />
        </Field>
        <Field label="Letter spacing">
          <NumberInput title="Letter spacing" value={common((n) => (n as TextNode).letterSpacing)} step={0.1} onCommit={(v) => commit(() => ({ letterSpacing: v }), 'Set Letter Spacing')} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-2.5">
        <Field label="Align">
          <Segmented
            value={common((n) => (n as TextNode).textAlignH)}
            options={[
              { value: 'LEFT', label: <TextAlignLeftIcon width={12} height={12} />, title: 'Align left' },
              { value: 'CENTER', label: <TextAlignCenterIcon width={12} height={12} />, title: 'Align center' },
              { value: 'RIGHT', label: <TextAlignRightIcon width={12} height={12} />, title: 'Align right' },
            ]}
            onChange={(v) => commit(() => ({ textAlignH: v }), 'Set Text Align')}
          />
        </Field>
        <Field label="Vertical">
          <Segmented
            value={common((n) => (n as TextNode).textAlignV)}
            options={[
              { value: 'TOP', label: <TextTopIcon width={12} height={12} />, title: 'Align top' },
              { value: 'CENTER', label: <TextMiddleIcon width={12} height={12} />, title: 'Align middle' },
              { value: 'BOTTOM', label: <TextBottomIcon width={12} height={12} />, title: 'Align bottom' },
            ]}
            onChange={(v) => commit(() => ({ textAlignV: v }), 'Set Vertical Align')}
          />
        </Field>
      </div>
      <Field label="Resizing" className="mt-2.5" hint="Whether the text box follows the text or holds its size">
        <Segmented
          value={common((n) => (n as TextNode).autoResize)}
          options={[
            { value: 'WIDTH_AND_HEIGHT', label: 'Auto', title: 'Grow in both directions' },
            { value: 'HEIGHT', label: 'Auto H', title: 'Fixed width, auto height' },
            { value: 'NONE', label: 'Fixed', title: 'Fixed size' },
          ]}
          onChange={(v) => commit(() => ({ autoResize: v }), 'Set Resize Mode')}
        />
      </Field>
    </div>
  )
}
