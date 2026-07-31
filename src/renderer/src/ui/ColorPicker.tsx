// Popover color picker: SV square + hue + alpha sliders + hex input.
// Emits live updates while dragging; the caller commits history on close.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { RGBA } from '../engine/types'
import { hexToRgba, hsvToRgb, rgbToHsv, rgbaToHex } from '../engine/color'

interface Props {
  color: RGBA
  anchor: { x: number; y: number }
  onLive: (c: RGBA) => void
  onClose: () => void
}

export function ColorPicker({ color, anchor, onLive, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [hsv, setHsv] = useState(() => rgbToHsv(color.r, color.g, color.b))
  const [alpha, setAlpha] = useState(color.a)
  const [hexText, setHexText] = useState(rgbaToHex(color))

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [onClose])

  const rgb = useMemo(() => hsvToRgb(hsv.h, hsv.s, hsv.v), [hsv])

  const push = (h: number, s: number, v: number, a: number) => {
    const c = hsvToRgb(h, s, v)
    setHexText(rgbaToHex({ ...c, a }))
    onLive({ r: c.r, g: c.g, b: c.b, a })
  }

  const dragSlider = (
    e: React.PointerEvent,
    update: (ratioX: number, ratioY: number) => void,
  ) => {
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

  const left = Math.min(anchor.x, window.innerWidth - 260)
  const top = Math.min(anchor.y, window.innerHeight - 330)

  return (
    <div
      ref={ref}
      className="fixed z-50 w-60 p-3 rounded-md shadow-2xl border border-[var(--pf-border)] bg-[#242424]"
      style={{ left, top }}
    >
      {/* SV square */}
      <div
        className="relative w-full h-40 rounded cursor-crosshair mb-3"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})`,
        }}
        onPointerDown={(e) =>
          dragSlider(e, (rx, ry) => {
            setHsv((prev) => {
              const next = { ...prev, s: rx, v: 1 - ry }
              push(next.h, next.s, next.v, alpha)
              return next
            })
          })
        }
      >
        <div
          className="absolute w-3 h-3 rounded-full border-2 border-white shadow -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
        />
      </div>

      {/* Hue */}
      <div
        className="relative w-full h-3 rounded cursor-pointer mb-2"
        style={{
          background:
            'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
        }}
        onPointerDown={(e) =>
          dragSlider(e, (rx) => {
            setHsv((prev) => {
              const next = { ...prev, h: rx * 360 }
              push(next.h, next.s, next.v, alpha)
              return next
            })
          })
        }
      >
        <div
          className="absolute top-1/2 w-3 h-3 rounded-full border-2 border-white shadow -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ left: `${(hsv.h / 360) * 100}%` }}
        />
      </div>

      {/* Alpha */}
      <div
        className="relative w-full h-3 rounded cursor-pointer mb-3"
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
          className="absolute top-1/2 w-3 h-3 rounded-full border-2 border-white shadow -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ left: `${alpha * 100}%` }}
        />
      </div>

      {/* Hex + alpha inputs */}
      <div className="flex gap-2">
        <div className="flex items-center gap-1 flex-1">
          <span className="text-[10px] text-[var(--pf-text-dim)]">#</span>
          <input
            className="pf-input"
            value={hexText}
            onChange={(e) => setHexText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            onBlur={() => {
              const parsed = hexToRgba(hexText, alpha)
              if (parsed) {
                const nextHsv = rgbToHsv(parsed.r, parsed.g, parsed.b)
                setHsv(nextHsv)
                onLive(parsed)
                setHexText(rgbaToHex(parsed))
              }
            }}
          />
        </div>
        <div className="w-16 flex items-center gap-1">
          <input
            className="pf-input"
            value={Math.round(alpha * 100)}
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
    </div>
  )
}
