// The pointer set.
//
// A cursor is a string the browser either understands or silently ignores, and
// an ignored one falls back to the plain arrow — which looks like a cursor
// working. So these pin the parts that decide whether it is used at all: the
// hotspot, the fallback keyword, and that a badge actually changes the image.

import { describe, expect, it } from 'vitest'
import { ROTATE_CURSOR, pointerCursor, type CursorBadge } from './cursors'
import { CURSOR_ARROW, CURSOR_TIP } from './cursor-paths'

const ALL: CursorBadge[] = ['none', 'add', 'remove', 'move', 'bend', 'cut', 'paint', 'join']

describe('pointer cursors', () => {
  it('puts the hotspot on the arrow tip and keeps a fallback', () => {
    // Read from the SAME generated data the shape comes from, not typed in
    // again — that is the whole point of generating it. Redrawing the arrow in
    // resources/cursor-arrow.svg moves the tip and the aim together, and a test
    // holding its own copy of the number would keep passing while they parted.
    const tip = `${Math.round(CURSOR_TIP.x)} ${Math.round(CURSOR_TIP.y)}`
    for (const badge of ALL) {
      const css = pointerCursor(badge)
      expect(css.endsWith(`) ${tip}, default`)).toBe(true)
      expect(css.startsWith('url("data:image/svg+xml,')).toBe(true)
    }
  })

  it('draws the arrow the generator produced', () => {
    // A cursor whose shape had silently emptied would still be a valid CSS
    // string and would fall back to the system arrow, which looks like it works.
    expect(CURSOR_ARROW.length).toBeGreaterThan(10)
    expect(decodeURIComponent(pointerCursor('none'))).toContain(CURSOR_ARROW)
  })

  it('keeps the tip clear of the edge, so the rim is not shaved off', () => {
    // The corners are rounded with a fat stroke; a tip against the boundary
    // loses its outline on two sides and stops reading as a point.
    expect(CURSOR_TIP.x).toBeGreaterThanOrEqual(3)
    expect(CURSOR_TIP.y).toBeGreaterThanOrEqual(3)
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
