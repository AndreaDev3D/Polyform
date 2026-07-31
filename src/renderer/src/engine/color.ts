import type { RGBA } from './types'

export function rgbaToCss(c: RGBA, extraOpacity = 1): string {
  const a = Math.max(0, Math.min(1, c.a * extraOpacity))
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${a.toFixed(4)})`
}

export function rgbaToHex(c: RGBA): string {
  const h = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase()
}

export function hexToRgba(hex: string, alpha = 1): RGBA | null {
  let s = hex.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map((ch) => ch + ch).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
    a: alpha,
  }
}

/** h in [0,360), s/v in [0,1] */
export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return { r: r + m, g: g + m, b: b + m }
}

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  if (h < 0) h += 360
  return { h, s: max === 0 ? 0 : d / max, v: max }
}
