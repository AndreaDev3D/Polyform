// Popover colour picker. Emits live updates while dragging; the caller
// commits history on close.
//
// Redesign notes — the old one was an SV square, three sliders and a hex
// field, which meant every colour had to be re-derived by eye even if the
// document already used it. Added:
//   - paint type switching in place (solid / linear / radial), so you don't
//     close the picker to change what kind of paint it is
//   - the OS eyedropper, so any pixel on screen is a colour source
//   - the colours already on this page, most-used first
//   - shared colour styles, applied BY REFERENCE (so editing the style
//     later still updates the layer) — distinct from copying its value
//   - recents, so the last dozen colours are one click away
// Everything optional: callers that only want a colour keep passing
// `color`/`onLive` and get exactly the old behaviour.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { RGBA } from '../engine/types'
import { hexToRgba, hsvToRgb, rgbToHsv, rgbaToHex } from '../engine/color'
import { documentSwatches, pushRecentColor, recentSwatches, styleSwatches } from './swatches'

/** Chromium's EyeDropper; not in the TS DOM lib yet. */
interface EyeDropperCtor {
  new (): { open(): Promise<{ sRGBHex: string }> }
}

export type PickerPaintType = 'SOLID' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL'

interface Props {
  color: RGBA
  /** The LEFT/TOP of the control that opened this. Placement is decided here. */
  anchor: { x: number; y: number }
  onLive: (c: RGBA) => void
  onClose: () => void
  /** Present for fills/strokes that can change paint type. */
  paintType?: PickerPaintType
  onPaintType?: (t: PickerPaintType) => void
  /** Present when the target can take a shared style by reference. */
  onApplyStyle?: (styleId: string) => void
}

const TYPE_TABS: { value: PickerPaintType; label: string; css: string }[] = [
  { value: 'SOLID', label: 'Solid', css: 'linear-gradient(#9a9a9a,#9a9a9a)' },
  { value: 'GRADIENT_LINEAR', label: 'Linear', css: 'linear-gradient(90deg,#111,#eee)' },
  { value: 'GRADIENT_RADIAL', label: 'Radial', css: 'radial-gradient(circle at 30% 30%,#eee,#111)' },
]

export function ColorPicker({
  color,
  anchor,
  onLive,
  onClose,
  paintType,
  onPaintType,
  onApplyStyle,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [hsv, setHsv] = useState(() => rgbToHsv(color.r, color.g, color.b))
  const [alpha, setAlpha] = useState(color.a)
  const [hexText, setHexText] = useState(rgbaToHex(color))
  const [tab, setTab] = useState<'custom' | 'styles'>('custom')

  // Read the document once per open: these lists must not churn mid-drag.
  const docColors = useMemo(() => documentSwatches(), [])
  const styles = useMemo(() => styleSwatches(), [])
  const recents = useMemo(() => recentSwatches(), [])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  // Remember the colour the user settled on, not every frame they dragged
  // past — so a ref, read once on unmount rather than a stale closure.
  const settled = useRef<RGBA>(color)
  useEffect(() => () => pushRecentColor(settled.current), [])

  const rgb = useMemo(() => hsvToRgb(hsv.h, hsv.s, hsv.v), [hsv])

  const push = (h: number, s: number, v: number, a: number) => {
    const c = hsvToRgb(h, s, v)
    setHexText(rgbaToHex({ ...c, a }))
    settled.current = { r: c.r, g: c.g, b: c.b, a }
    onLive(settled.current)
  }

  /** Apply a concrete colour from a swatch/eyedropper (keeps alpha). */
  const applyColor = (c: RGBA, keepAlpha = true) => {
    const a = keepAlpha ? alpha : c.a
    setHsv(rgbToHsv(c.r, c.g, c.b))
    setAlpha(a)
    setHexText(rgbaToHex({ ...c, a }))
    settled.current = { r: c.r, g: c.g, b: c.b, a }
    onLive(settled.current)
  }

  const dragSlider = (e: React.PointerEvent, update: (rx: number, ry: number) => void) => {
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    const apply = (ev: { clientX: number; clientY: number }) => {
      const rx = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      const ry = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height))
      update(rx, ry)
    }
    apply(e)
    const onMove = (ev: PointerEvent) => apply(ev)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const hueColor = useMemo(() => {
    const c = hsvToRgb(hsv.h, 1, 1)
    return `rgb(${c.r * 255}, ${c.g * 255}, ${c.b * 255})`
  }, [hsv.h])

  const eyeDropper = (globalThis as { EyeDropper?: EyeDropperCtor }).EyeDropper
  const pickFromScreen = async () => {
    if (!eyeDropper) return
    try {
      const { sRGBHex } = await new eyeDropper().open()
      const parsed = hexToRgba(sRGBHex.replace('#', ''), alpha)
      if (parsed) applyColor(parsed)
    } catch {
      /* the user pressed Escape — not an error */
    }
  }

  const W = 268
  const GAP = 10
  // BESIDE the panel, never over it. `anchor.x` is the LEFT EDGE of the swatch that
  // opened this, so the picker's right edge lands a gap short of it — the panel it
  // came from stays fully readable while you pick, which is the whole point of
  // opening a picker from a row you are looking at. Callers used to subtract a
  // hard-coded 260 themselves, which is this width minus 8 and so overlapped by
  // however much the two numbers disagreed.
  //
  // Flips to the right of the anchor only if there is genuinely no room on the left
  // (a narrow window), and is clamped to the viewport either way.
  const wantLeft = anchor.x - W - GAP
  const left = wantLeft >= 8 ? wantLeft : Math.min(anchor.x + 32, window.innerWidth - W - 8)
  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - 430))

  const swatchGrid = (items: { key: string; css: string; title: string; onClick: () => void }[]) => (
    <div className="grid grid-cols-9 gap-1">
      {items.map((s) => (
        <button
          key={s.key}
          title={s.title}
          aria-label={s.title}
          className="pf-swatch"
          style={{ background: s.css }}
          onClick={s.onClick}
        />
      ))}
    </div>
  )

  return (
    <div
      ref={ref}
      className="fixed z-50 pf-floating p-3"
      style={{ left, top, width: W }}
      role="dialog"
      aria-label="Colour picker"
    >
      {/* Tabs — only when there is a second thing to show. */}
      {styles.length > 0 && (
        <div className="flex gap-1 mb-2.5 p-0.5 rounded-md bg-[var(--pf-bg-0)]">
          {(['custom', 'styles'] as const).map((t) => (
            <button
              key={t}
              className={`flex-1 rounded text-[11px] py-1 capitalize cursor-default transition-colors ${
                tab === t ? 'bg-[var(--pf-bg-3)] text-[var(--pf-text)]' : 'text-[var(--pf-text-dim)]'
              }`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {tab === 'styles' ? (
        <div>
          <div className="pf-picker-label">Colour styles</div>
          <div className="max-h-64 overflow-y-auto -mx-1 px-1">
            {styles.map((s) => (
              <button
                key={s.id}
                className="w-full flex items-center gap-2 py-1 px-1 rounded hover:bg-[var(--pf-bg-2)] cursor-default text-left"
                onClick={() => {
                  if (onApplyStyle) onApplyStyle(s.id)
                  else if (s.color) applyColor(s.color, false)
                  onClose()
                }}
              >
                <span className="pf-swatch shrink-0" style={{ background: s.css }} />
                <span className="text-[11px] truncate flex-1">{s.name}</span>
              </button>
            ))}
          </div>
          {!onApplyStyle && (
            <div className="mt-2 text-[10px] text-[var(--pf-text-dim)]">
              Applies the style's colour value here.
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Paint type, in place. */}
          {paintType && onPaintType && (
            <div className="flex gap-1 mb-2.5">
              {TYPE_TABS.map((t) => (
                <button
                  key={t.value}
                  title={t.label}
                  aria-pressed={paintType === t.value}
                  className={`flex-1 h-7 rounded-md border cursor-default transition-colors ${
                    paintType === t.value
                      ? 'border-[var(--pf-accent)]'
                      : 'border-[var(--pf-border)] hover:border-[var(--pf-text-dim)]'
                  }`}
                  style={{ background: t.css }}
                  onClick={() => onPaintType(t.value)}
                />
              ))}
            </div>
          )}

          {/* SV square */}
          <div
            className="relative w-full h-40 rounded-lg cursor-crosshair mb-2.5 overflow-hidden"
            style={{
              background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})`,
            }}
            onPointerDown={(e) =>
              dragSlider(e, (rx, ry) =>
                setHsv((prev) => {
                  const next = { ...prev, s: rx, v: 1 - ry }
                  push(next.h, next.s, next.v, alpha)
                  return next
                }),
              )
            }
          >
            <div
              className="absolute w-3.5 h-3.5 rounded-full border-2 border-white -translate-x-1/2 -translate-y-1/2 pointer-events-none"
              style={{
                left: `${hsv.s * 100}%`,
                top: `${(1 - hsv.v) * 100}%`,
                boxShadow: '0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(0,0,0,0.25)',
              }}
            />
          </div>

          {/* Hue */}
          <div
            className="relative w-full h-3 rounded-full cursor-pointer mb-2"
            style={{ background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
            onPointerDown={(e) =>
              dragSlider(e, (rx) =>
                setHsv((prev) => {
                  const next = { ...prev, h: rx * 360 }
                  push(next.h, next.s, next.v, alpha)
                  return next
                }),
              )
            }
          >
            <div className="pf-slider-knob" style={{ left: `${(hsv.h / 360) * 100}%`, background: hueColor }} />
          </div>

          {/* Alpha */}
          <div
            className="relative w-full h-3 rounded-full cursor-pointer mb-2.5"
            style={{
              backgroundImage: `linear-gradient(to right, transparent, rgb(${rgb.r * 255}, ${rgb.g * 255}, ${rgb.b * 255})), repeating-conic-gradient(#666 0 25%, #999 0 50%)`,
              backgroundSize: 'auto, 8px 8px',
            }}
            onPointerDown={(e) =>
              dragSlider(e, (rx) => {
                setAlpha(rx)
                push(hsv.h, hsv.s, hsv.v, rx)
              })
            }
          >
            <div
              className="pf-slider-knob"
              style={{ left: `${alpha * 100}%`, background: `rgba(${rgb.r * 255},${rgb.g * 255},${rgb.b * 255},${alpha})` }}
            />
          </div>

          {/* Eyedropper + hex + opacity */}
          <div className="flex gap-1.5 items-center">
            {eyeDropper && (
              <button
                className="pf-tool-btn !w-7 !h-7 shrink-0 bg-[var(--pf-bg-0)]"
                title="Pick a colour from the screen"
                aria-label="Pick a colour from the screen"
                onClick={() => void pickFromScreen()}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <path d="M11 2.5l2.5 2.5M9.8 3.7l2.5 2.5-6.6 6.6-3 .5.5-3 6.6-6.6z" />
                </svg>
              </button>
            )}
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <span className="text-[10px] text-[var(--pf-text-dim)]">#</span>
              <input
                className="pf-input font-mono"
                value={hexText}
                spellCheck={false}
                aria-label="Hex colour"
                onChange={(e) => setHexText(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                onBlur={() => {
                  const parsed = hexToRgba(hexText, alpha)
                  if (parsed) applyColor(parsed)
                  else setHexText(rgbaToHex({ ...rgb, a: alpha }))
                }}
              />
            </div>
            <div className="w-14 flex items-center gap-1 shrink-0">
              <input
                className="pf-input tabular-nums"
                value={Math.round(alpha * 100)}
                aria-label="Opacity percent"
                onChange={(e) => {
                  const v = Math.max(0, Math.min(100, parseInt(e.target.value || '0', 10)))
                  if (!Number.isNaN(v)) {
                    setAlpha(v / 100)
                    push(hsv.h, hsv.s, hsv.v, v / 100)
                  }
                }}
                onKeyDown={(e) => e.stopPropagation()}
              />
              <span className="text-[10px] text-[var(--pf-text-dim)]">%</span>
            </div>
          </div>

          {docColors.length > 0 && (
            <>
              <div className="pf-picker-label">On this page</div>
              {swatchGrid(
                docColors.map((s) => ({
                  key: s.hex,
                  css: s.hex,
                  title: `${s.hex} · used ${s.uses}×`,
                  onClick: () => applyColor(s.color),
                })),
              )}
            </>
          )}

          {recents.length > 0 && (
            <>
              <div className="pf-picker-label">Recent</div>
              {swatchGrid(
                recents.map((s, i) => ({
                  key: `${s.hex}-${i}`,
                  css: s.hex,
                  title: s.hex,
                  onClick: () => applyColor(s.color),
                })),
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
