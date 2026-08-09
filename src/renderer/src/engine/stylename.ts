// A shared style has to be born with a name. Electron does not implement
// `window.prompt` — it throws — so asking for one up front is not an option
// (F-31); the name comes from what is being saved and is renamed in place
// afterwards.

import { rgbaToHex } from './color'
import type { Paint, TextStyleProps } from './types'

/** What to call a colour style made from this paint. */
export function defaultColorStyleName(paint: Paint): string {
  switch (paint.type) {
    case 'SOLID':
      return rgbaToHex(paint.color)
    case 'GRADIENT_LINEAR':
      return 'Linear gradient'
    case 'GRADIENT_RADIAL':
      return 'Radial gradient'
    case 'IMAGE':
      return 'Image'
  }
}

/** What to call a text style made from these properties. */
export function defaultTextStyleName(props: TextStyleProps): string {
  const weight =
    props.fontWeight >= 700 ? ' Bold' : props.fontWeight >= 600 ? ' Semibold' : props.fontWeight <= 300 ? ' Light' : ''
  return `${props.fontFamily}${weight}${props.italic ? ' Italic' : ''} ${props.fontSize}`
}

/**
 * `base`, or `base 2`, `base 3`… — whichever is free. Two swatches of the same
 * colour are an ordinary thing to save, and two styles called `135BEC` would be
 * indistinguishable in every list that shows them.
 */
export function uniqueStyleName(base: string, taken: readonly string[]): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!used.has(candidate)) return candidate
  }
}
