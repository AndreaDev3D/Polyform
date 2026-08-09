import { describe, expect, it } from 'vitest'
import { defaultColorStyleName, defaultTextStyleName, uniqueStyleName } from './stylename'
import type { Paint, TextStyleProps } from './types'

const solid = (r: number, g: number, b: number): Paint => ({
  type: 'SOLID',
  visible: true,
  opacity: 1,
  color: { r, g, b, a: 1 },
})

describe('default style names', () => {
  it('names a solid style after its hex', () => {
    // The colour from the report: #135BEC.
    expect(defaultColorStyleName(solid(0x13 / 255, 0x5b / 255, 0xec / 255))).toBe('135BEC')
  })

  it('names the paints that have no single colour', () => {
    const stops = [
      { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
    ]
    const gradient = { visible: true, opacity: 1, stops, start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }
    expect(defaultColorStyleName({ ...gradient, type: 'GRADIENT_LINEAR' })).toBe('Linear gradient')
    expect(defaultColorStyleName({ ...gradient, type: 'GRADIENT_RADIAL' })).toBe('Radial gradient')
    expect(
      defaultColorStyleName({ type: 'IMAGE', visible: true, opacity: 1, assetHash: 'abc', scaleMode: 'FILL' }),
    ).toBe('Image')
  })

  it('describes a text style by what makes it different', () => {
    const base: TextStyleProps = {
      fontFamily: 'Inter',
      fontWeight: 400,
      italic: false,
      fontSize: 16,
      lineHeight: 1.4,
      letterSpacing: 0,
    }
    expect(defaultTextStyleName(base)).toBe('Inter 16')
    expect(defaultTextStyleName({ ...base, fontWeight: 700 })).toBe('Inter Bold 16')
    expect(defaultTextStyleName({ ...base, fontWeight: 600, italic: true })).toBe('Inter Semibold Italic 16')
    expect(defaultTextStyleName({ ...base, fontWeight: 300, fontSize: 11 })).toBe('Inter Light 11')
  })
})

describe('unique style names', () => {
  it('leaves a free name alone', () => {
    expect(uniqueStyleName('135BEC', ['FFFFFF'])).toBe('135BEC')
    expect(uniqueStyleName('135BEC', [])).toBe('135BEC')
  })

  it('counts up past every taken one', () => {
    expect(uniqueStyleName('135BEC', ['135BEC'])).toBe('135BEC 2')
    expect(uniqueStyleName('135BEC', ['135BEC', '135BEC 2'])).toBe('135BEC 3')
    // A gap is fair game: the point is a free name, not the highest number.
    expect(uniqueStyleName('135BEC', ['135BEC', '135BEC 3'])).toBe('135BEC 2')
  })
})
