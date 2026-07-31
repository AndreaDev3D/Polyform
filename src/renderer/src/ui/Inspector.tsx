// Right-hand inspector: transform, appearance, fills/strokes/effects, text,
// auto layout, boolean ops, export. Edits apply to the whole selection and
// commit through the history system (live color edits commit on close).

import { useRef, useState } from 'react'
import type {
  AutoLayout,
  BlendMode,
  BooleanOp,
  Effect,
  FrameNode,
  NodeId,
  Paint,
  RGBA,
  SceneNode,
  TextNode,
} from '../engine/types'
import { solid } from '../engine/types'
import { documentStore, useDocVersion } from '../state/document'
import { useEditor } from '../state/editor'
import {
  alignSelection,
  distributeSelection,
  exportSelection,
  selectedIds,
  updateSelectedNodes,
} from '../state/actions'
import type { PatchOp } from '../engine/commands'
import { NumberInput, Section, Segmented, Select, round } from './components'
import { ColorPicker } from './ColorPicker'
import { rgbaToCss, rgbaToHex } from '../engine/color'
import {
  AlignBottomIcon,
  AlignHCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  AlignTopIcon,
  AlignVCenterIcon,
  DistributeHIcon,
  DistributeVIcon,
  EyeIcon,
  EyeOffIcon,
  MinusIcon,
  PlusIcon,
} from './icons'

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

export function Inspector() {
  useDocVersion()
  const selection = useEditor((s) => s.selection)
  const fonts = useEditor((s) => s.fonts)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [cornersExpanded, setCornersExpanded] = useState(false)
  const [exportScale, setExportScale] = useState(2)
  const pickerSnapshot = useRef<Map<NodeId, { fills: Paint[]; strokes: Paint[]; effects: Effect[] }> | null>(null)

  const scene = documentStore.scene
  const nodes = selection.map((id) => scene.getNode(id)).filter((n): n is SceneNode => !!n)

  if (nodes.length === 0) {
    return (
      <div className="w-72 shrink-0 bg-[var(--pf-bg-0)] border-l border-[var(--pf-border)] overflow-y-auto">
        <div className="px-4 py-6 text-[11px] text-[var(--pf-text-dim)]">
          Select a layer to edit its properties.
          <div className="mt-4 space-y-1 leading-5">
            <div>V — Move · F — Frame · R — Rectangle</div>
            <div>O — Ellipse · L — Line · P — Pen · T — Text</div>
            <div>Ctrl+wheel — zoom · Space — pan</div>
          </div>
        </div>
      </div>
    )
  }

  const first = nodes[0]

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
        if (fx && fx.type === 'DROP_SHADOW') fx.color = { ...c }
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
      return fx && fx.type === 'DROP_SHADOW' ? fx.color : { r: 0, g: 0, b: 0, a: 1 }
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

  // ------------------------------------------------------------------

  const isFrame = nodes.every((n) => n.type === 'FRAME')
  const hasCorner = nodes.every((n) => n.type === 'RECTANGLE' || n.type === 'FRAME')
  const isText = nodes.every((n) => n.type === 'TEXT')
  const isBool = nodes.every((n) => n.type === 'BOOLEAN')
  const isPolygon = nodes.every((n) => n.type === 'POLYGON')
  const isStar = nodes.every((n) => n.type === 'STAR')

  return (
    <div className="w-72 shrink-0 bg-[var(--pf-bg-0)] border-l border-[var(--pf-border)] overflow-y-auto select-none">
      {/* Align */}
      <div className="pf-section flex items-center justify-between">
        <button className="pf-icon-btn" title="Align left" onClick={() => alignSelection('left')}><AlignLeftIcon /></button>
        <button className="pf-icon-btn" title="Align horizontal centers" onClick={() => alignSelection('hcenter')}><AlignHCenterIcon /></button>
        <button className="pf-icon-btn" title="Align right" onClick={() => alignSelection('right')}><AlignRightIcon /></button>
        <button className="pf-icon-btn" title="Align top" onClick={() => alignSelection('top')}><AlignTopIcon /></button>
        <button className="pf-icon-btn" title="Align vertical centers" onClick={() => alignSelection('vcenter')}><AlignVCenterIcon /></button>
        <button className="pf-icon-btn" title="Align bottom" onClick={() => alignSelection('bottom')}><AlignBottomIcon /></button>
        <button className="pf-icon-btn" title="Distribute horizontally" onClick={() => distributeSelection('h')}><DistributeHIcon /></button>
        <button className="pf-icon-btn" title="Distribute vertically" onClick={() => distributeSelection('v')}><DistributeVIcon /></button>
      </div>

      {/* Transform */}
      <Section title={nodes.length === 1 ? first.name : `${nodes.length} layers`}>
        <div className="grid grid-cols-2 gap-2">
          <NumberInput label="X" value={common((n) => round(n.x))} onCommit={(v) => commit(() => ({ x: v }), 'Set X')} />
          <NumberInput label="Y" value={common((n) => round(n.y))} onCommit={(v) => commit(() => ({ y: v }), 'Set Y')} />
          <NumberInput label="W" value={common((n) => round(n.width))} min={0.5} onCommit={(v) => commit(() => ({ width: v }), 'Set Width')} />
          <NumberInput label="H" value={common((n) => round(n.height))} min={0} onCommit={(v) => commit(() => ({ height: v }), 'Set Height')} />
          <NumberInput label="⟳" value={common((n) => round(n.rotation))} suffix="°" onCommit={(v) => commit(() => ({ rotation: v }), 'Set Rotation')} />
          {hasCorner && !cornersExpanded && (
            <NumberInput
              label="⌒"
              value={common((n) => {
                const r = (n as { cornerRadius?: { tl: number; tr: number; br: number; bl: number } }).cornerRadius
                if (!r) return 0
                return r.tl === r.tr && r.tr === r.br && r.br === r.bl ? round(r.tl) : NaN
              })}
              min={0}
              onCommit={(v) => commit(() => ({ cornerRadius: { tl: v, tr: v, br: v, bl: v } }), 'Set Corner Radius')}
            />
          )}
        </div>
        {hasCorner && (
          <button className="mt-1.5 text-[10px] text-[var(--pf-text-dim)] hover:text-white" onClick={() => setCornersExpanded(!cornersExpanded)}>
            {cornersExpanded ? '− Uniform corner radius' : '+ Individual corners'}
          </button>
        )}
        {hasCorner && cornersExpanded && (
          <div className="grid grid-cols-4 gap-1 mt-1">
            {(['tl', 'tr', 'br', 'bl'] as const).map((corner) => (
              <NumberInput
                key={corner}
                value={common((n) => round((n as unknown as { cornerRadius: Record<string, number> }).cornerRadius[corner]))}
                min={0}
                onCommit={(v) =>
                  commit((n) => ({ cornerRadius: { ...(n as unknown as { cornerRadius: Record<string, number> }).cornerRadius, [corner]: v } }), 'Set Corner Radius')
                }
              />
            ))}
          </div>
        )}
        {isPolygon && (
          <div className="grid grid-cols-2 gap-2 mt-2">
            <NumberInput label="N" value={common((n) => (n as { pointCount: number }).pointCount)} min={3} max={60} onCommit={(v) => commit(() => ({ pointCount: Math.round(v) }), 'Set Points')} />
          </div>
        )}
        {isStar && (
          <div className="grid grid-cols-2 gap-2 mt-2">
            <NumberInput label="N" value={common((n) => (n as { pointCount: number }).pointCount)} min={3} max={60} onCommit={(v) => commit(() => ({ pointCount: Math.round(v) }), 'Set Points')} />
            <NumberInput label="%" value={common((n) => round((n as { innerRatio: number }).innerRatio * 100))} min={1} max={100} onCommit={(v) => commit(() => ({ innerRatio: v / 100 }), 'Set Inner Radius')} />
          </div>
        )}
        {isBool && (
          <div className="mt-2">
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
          </div>
        )}
      </Section>

      {/* Auto layout */}
      {isFrame && (
        <Section title="Auto layout">
          <AutoLayoutEditor frame={first as FrameNode} commit={commit} common={common} />
        </Section>
      )}

      {/* Appearance */}
      <Section title="Appearance">
        <div className="grid grid-cols-2 gap-2">
          <NumberInput
            label="◐"
            value={common((n) => round(n.opacity * 100))}
            min={0}
            max={100}
            suffix="%"
            onCommit={(v) => commit(() => ({ opacity: v / 100 }), 'Set Opacity')}
          />
          <Select<BlendMode>
            value={(common((n) => n.blendMode) ?? '') as BlendMode | ''}
            options={BLEND_OPTIONS}
            onChange={(v) => commit(() => ({ blendMode: v }), 'Set Blend Mode')}
          />
        </div>
      </Section>

      {/* Text */}
      {isText && (
        <Section title="Text">
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
        {first.fills.length === 0 && <div className="text-[11px] text-[var(--pf-text-dim)]">No fill</div>}
        {first.fills.map((paint, i) => (
          <PaintRow
            key={i}
            paint={paint}
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
          />
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
          />
        ))}
        {first.strokes.length > 0 && (
          <div className="grid grid-cols-3 gap-2 mt-2">
            <NumberInput label="W" value={common((n) => round(n.strokeWeight))} min={0} onCommit={(v) => commit(() => ({ strokeWeight: v }), 'Set Stroke Weight')} />
            <Select
              value={(common((n) => n.strokeAlign) ?? '') as 'CENTER' | 'INSIDE' | 'OUTSIDE' | ''}
              options={[
                { value: 'INSIDE', label: 'Inside' },
                { value: 'CENTER', label: 'Center' },
                { value: 'OUTSIDE', label: 'Outside' },
              ]}
              onChange={(v) => commit(() => ({ strokeAlign: v }), 'Set Stroke Align')}
              className="col-span-1"
            />
            <Select
              value={common((n) => (n.strokeDash.length > 0 ? 'dash' : 'solid')) ?? ''}
              options={[
                { value: 'solid', label: 'Solid' },
                { value: 'dash', label: 'Dashed' },
              ]}
              onChange={(v) => commit((n) => ({ strokeDash: v === 'dash' ? [n.strokeWeight * 3, n.strokeWeight * 3] : [] }), 'Set Dash')}
            />
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
                  { value: 'LAYER_BLUR', label: 'Layer blur' },
                ]}
                onChange={(t) =>
                  commit((n) => {
                    const effects = structuredClone(n.effects)
                    effects[i] =
                      t === 'DROP_SHADOW'
                        ? { type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, blur: 8 }
                        : { type: 'LAYER_BLUR', visible: true, radius: 4 }
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
            {fx.type === 'DROP_SHADOW' && (
              <div className="grid grid-cols-4 gap-1 mt-1 items-center">
                <NumberInput label="X" value={round(fx.offset.x)} onCommit={(v) => commit((n) => patchEffect(n, i, (e) => e.type === 'DROP_SHADOW' && (e.offset = { ...e.offset, x: v })), 'Set Shadow')} />
                <NumberInput label="Y" value={round(fx.offset.y)} onCommit={(v) => commit((n) => patchEffect(n, i, (e) => e.type === 'DROP_SHADOW' && (e.offset = { ...e.offset, y: v })), 'Set Shadow')} />
                <NumberInput label="B" value={round(fx.blur)} min={0} onCommit={(v) => commit((n) => patchEffect(n, i, (e) => e.type === 'DROP_SHADOW' && (e.blur = v)), 'Set Shadow')} />
                <button
                  className="w-6 h-6 rounded border border-[var(--pf-border)]"
                  style={{ background: rgbaToCss(fx.color) }}
                  title="Shadow color"
                  onClick={(e) => {
                    const r = (e.target as HTMLElement).getBoundingClientRect()
                    openPicker({ kind: 'effect', index: i, anchor: { x: r.left - 260, y: r.top } })
                  }}
                />
              </div>
            )}
            {fx.type === 'LAYER_BLUR' && (
              <div className="grid grid-cols-2 gap-1 mt-1">
                <NumberInput label="R" value={round(fx.radius)} min={0} onCommit={(v) => commit((n) => patchEffect(n, i, (e) => e.type === 'LAYER_BLUR' && (e.radius = v)), 'Set Blur')} />
              </div>
            )}
          </div>
        ))}
      </Section>

      {/* Export */}
      <Section title="Export">
        <div className="flex items-center gap-2">
          <Select
            value={String(exportScale)}
            options={[
              { value: '1', label: '1x' },
              { value: '2', label: '2x' },
              { value: '3', label: '3x' },
              { value: '4', label: '4x' },
            ]}
            onChange={(v) => setExportScale(parseInt(v, 10))}
            className="w-16"
          />
          <button className="pf-btn flex-1 bg-[var(--pf-bg-3)]" onClick={() => void exportSelection('png', exportScale)}>
            PNG
          </button>
          <button className="pf-btn flex-1 bg-[var(--pf-bg-3)]" onClick={() => void exportSelection('svg')}>
            SVG
          </button>
        </div>
      </Section>

      {picker && <ColorPicker color={pickerColor} anchor={picker.anchor} onLive={livePaintColor} onClose={closePicker} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

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

function PaintRow({
  paint,
  onSwatch,
  onToggle,
  onRemove,
  onTypeChange,
  onScaleModeChange,
}: {
  paint: Paint
  onSwatch: (anchor: { x: number; y: number }, stopIndex?: number) => void
  onToggle: () => void
  onRemove: () => void
  onTypeChange: (t: 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL') => void
  onScaleModeChange?: (m: 'FILL' | 'FIT' | 'TILE' | 'STRETCH') => void
}) {
  const isGradient = paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL'
  return (
    <div className="mb-1.5">
      <div className="flex items-center gap-1.5">
        <button
          className="w-6 h-6 rounded border border-[var(--pf-border)] shrink-0"
          style={{ background: paintSwatchCss(paint) }}
          onClick={(e) => {
            const r = (e.target as HTMLElement).getBoundingClientRect()
            onSwatch({ x: r.left - 260, y: r.top }, isGradient ? 0 : undefined)
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
      {isGradient && (
        <div className="flex items-center gap-1 mt-1 pl-8">
          {paint.stops.map((stop, si) => (
            <button
              key={si}
              className="w-4 h-4 rounded-full border border-[var(--pf-border)]"
              style={{ background: rgbaToCss(stop.color) }}
              title={`Stop ${Math.round(stop.position * 100)}%`}
              onClick={(e) => {
                const r = (e.target as HTMLElement).getBoundingClientRect()
                onSwatch({ x: r.left - 260, y: r.top }, si)
              }}
            />
          ))}
        </div>
      )}
    </div>
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
      <Segmented
        value={common((n) => (n as FrameNode).layout.mode)}
        options={[
          { value: 'NONE', label: 'None' },
          { value: 'HORIZONTAL', label: '→' },
          { value: 'VERTICAL', label: '↓' },
        ]}
        onChange={(v) => commit(layoutPatch((lay) => (lay.mode = v)), 'Set Auto Layout')}
      />
      {l.mode !== 'NONE' && (
        <>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <NumberInput label="␣" value={common((n) => (n as FrameNode).layout.gap)} onCommit={(v) => commit(layoutPatch((lay) => (lay.gap = v)), 'Set Gap')} />
            <NumberInput
              label="□"
              value={common((n) => {
                const lay = (n as FrameNode).layout
                return lay.paddingTop === lay.paddingRight && lay.paddingRight === lay.paddingBottom && lay.paddingBottom === lay.paddingLeft
                  ? lay.paddingTop
                  : NaN
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
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <Select
              value={(common((n) => (n as FrameNode).layout.counterAlign) ?? '') as 'MIN' | 'CENTER' | 'MAX' | ''}
              options={[
                { value: 'MIN', label: 'Align start' },
                { value: 'CENTER', label: 'Align center' },
                { value: 'MAX', label: 'Align end' },
              ]}
              onChange={(v) => commit(layoutPatch((lay) => (lay.counterAlign = v)), 'Set Alignment')}
            />
            <Select
              value={(common((n) => (n as FrameNode).layout.primarySizing) ?? '') as 'FIXED' | 'HUG' | ''}
              options={[
                { value: 'FIXED', label: 'Fixed size' },
                { value: 'HUG', label: 'Hug contents' },
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
      <input
        className="pf-input mb-2"
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
      <datalist id="pf-font-list">
        {fonts.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <div className="grid grid-cols-3 gap-2">
        <Select
          value={String(common((n) => (n as TextNode).fontWeight) ?? '')}
          options={[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => ({ value: String(w), label: String(w) }))}
          onChange={(v) => commit(() => ({ fontWeight: parseInt(v, 10) }), 'Set Weight')}
        />
        <NumberInput value={common((n) => (n as TextNode).fontSize)} min={1} onCommit={(v) => commit(() => ({ fontSize: v }), 'Set Font Size')} />
        <button
          className={`pf-btn italic ${node.italic ? 'bg-[var(--pf-accent)] text-white' : 'bg-[#2a2a2a]'}`}
          onClick={() => commit((n) => ({ italic: !(n as TextNode).italic }), 'Toggle Italic')}
        >
          I
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-2">
        <NumberInput label="↕" value={common((n) => round((n as TextNode).lineHeight * 100))} min={50} max={400} suffix="%" onCommit={(v) => commit(() => ({ lineHeight: v / 100 }), 'Set Line Height')} />
        <NumberInput label="↔" value={common((n) => (n as TextNode).letterSpacing)} step={0.1} onCommit={(v) => commit(() => ({ letterSpacing: v }), 'Set Letter Spacing')} />
      </div>
      <div className="grid grid-cols-2 gap-2 mt-2">
        <Segmented
          value={common((n) => (n as TextNode).textAlignH)}
          options={[
            { value: 'LEFT', label: '⤒'.replace('⤒', '⟸'), title: 'Align left' },
            { value: 'CENTER', label: '↔', title: 'Align center' },
            { value: 'RIGHT', label: '⟹', title: 'Align right' },
          ]}
          onChange={(v) => commit(() => ({ textAlignH: v }), 'Set Text Align')}
        />
        <Segmented
          value={common((n) => (n as TextNode).textAlignV)}
          options={[
            { value: 'TOP', label: '⤒', title: 'Align top' },
            { value: 'CENTER', label: '↕', title: 'Align middle' },
            { value: 'BOTTOM', label: '⤓', title: 'Align bottom' },
          ]}
          onChange={(v) => commit(() => ({ textAlignV: v }), 'Set Vertical Align')}
        />
      </div>
      <div className="mt-2">
        <Segmented
          value={common((n) => (n as TextNode).autoResize)}
          options={[
            { value: 'WIDTH_AND_HEIGHT', label: 'Auto', title: 'Auto width' },
            { value: 'HEIGHT', label: 'Auto H', title: 'Fixed width, auto height' },
            { value: 'NONE', label: 'Fixed', title: 'Fixed size' },
          ]}
          onChange={(v) => commit(() => ({ autoResize: v }), 'Set Resize Mode')}
        />
      </div>
    </div>
  )
}
