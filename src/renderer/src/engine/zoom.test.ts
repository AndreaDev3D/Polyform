import { describe, expect, it } from 'vitest'
import { MAX_ZOOM, MIN_ZOOM, clampZoom, formatZoom, parseZoomText } from './zoom'

describe('parseZoomText', () => {
  it('reads what people actually type', () => {
    expect(parseZoomText('54')).toBeCloseTo(0.54, 10)
    expect(parseZoomText('54%')).toBeCloseTo(0.54, 10)
    expect(parseZoomText('  200 % ')).toBe(2)
    expect(parseZoomText('12.5%')).toBeCloseTo(0.125, 10)
    // A comma decimal, because half the world types one.
    expect(parseZoomText('12,5%')).toBeCloseTo(0.125, 10)
  })

  it('keeps the result inside the limits', () => {
    expect(parseZoomText('999999%')).toBe(MAX_ZOOM)
    expect(parseZoomText('0.5')).toBe(MIN_ZOOM)
  })

  it('returns null rather than moving the camera to NaN', () => {
    for (const bad of ['', '   ', 'abc', '%', '-50', '5e2', '1/2', '50px', '0', '0%']) {
      expect(parseZoomText(bad), bad).toBeNull()
    }
  })

  it('round-trips the readout', () => {
    for (const zoom of [0.02, 0.1, 0.54, 1, 2.5, 16, 64]) {
      expect(parseZoomText(formatZoom(zoom))).toBeCloseTo(zoom, 2)
    }
  })
})

describe('clampZoom', () => {
  it('holds the ends', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM)
    expect(clampZoom(1000)).toBe(MAX_ZOOM)
    expect(clampZoom(0.75)).toBe(0.75)
  })
})

describe('formatZoom', () => {
  it('reads as a whole percentage', () => {
    expect(formatZoom(1)).toBe('100%')
    expect(formatZoom(0.535)).toBe('54%')
    expect(formatZoom(MIN_ZOOM)).toBe('2%')
    expect(formatZoom(MAX_ZOOM)).toBe('6400%')
  })
})
