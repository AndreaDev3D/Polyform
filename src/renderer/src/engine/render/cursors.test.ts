// The pointer set.
//
// A cursor is a string the browser either understands or silently ignores, and
// an ignored one falls back to the plain arrow — which looks like a cursor
// working. So these pin the parts that decide whether it is used at all: the
// hotspot, the fallback keyword, and that a badge actually changes the image.

import { describe, expect, it } from 'vitest'
import { ROTATE_CURSOR, pointerCursor, type CursorBadge } from './cursors'

const ALL: CursorBadge[] = ['none', 'add', 'remove', 'move', 'bend', 'cut', 'paint', 'join']

describe('pointer cursors', () => {
  it('puts the hotspot on the arrow tip and keeps a fallback', () => {
    for (const badge of ALL) {
      const css = pointerCursor(badge)
      // "2 2" is the tip. A cursor with the hotspot in the middle of the image
      // points a few pixels away from where you think you are aiming, which is
      // unusable for dragging anchors around.
      expect(css).toMatch(/\) 2 2, default$/)
      expect(css.startsWith('url("data:image/svg+xml,')).toBe(true)
    }
  })

  it('gives every badge its own image', () => {
    // Same string for two badges would mean one of them silently shows the
    // other's glyph — the failure this is easiest to ship without noticing.
    const seen = new Set(ALL.map((b) => pointerCursor(b)))
    expect(seen.size).toBe(ALL.length)
  })

  it('draws the plain pointer with no badge on it', () => {
    const plain = decodeURIComponent(pointerCursor('none'))
    const added = decodeURIComponent(pointerCursor('add'))
    // The disc only exists when something is being said.
    expect(plain).not.toContain('<circle')
    expect(added).toContain('<circle')
  })

  it('returns the identical string every time', () => {
    // `controller.cursor` is read on every pointer move. Rebuilding and
    // re-encoding an SVG at that rate is real work for a string that changes a
    // handful of times a session — and an unstable string would also make the
    // view reassign `style.cursor` on every move.
    expect(pointerCursor('add')).toBe(pointerCursor('add'))
  })

  it('keeps the rotate cursor centred on what it turns', () => {
    // Not the tip: the ring surrounds the point being rotated, which is what
    // every other rotate cursor does.
    expect(ROTATE_CURSOR).toMatch(/\) 12 12, alias$/)
  })
})
