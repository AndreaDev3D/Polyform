// The app's pointers, in one place.
//
// A cursor is the only piece of UI that is always under your eye and never in
// your way, which makes it the right place to answer "what will this click do?"
// — and the wrong place to answer it vaguely. So a pointer here is two things:
// the ARROW, which never changes, and a BADGE beside it that names the action.
// Add shows a plus, Delete a minus, Paint a drop. The arrow staying put across
// all of them is what makes the badge readable: the eye tracks one shape and
// reads the change beside it.
//
// Built as data-URI SVG rather than image files so the whole set is one
// function, versioned with the code, and legible as geometry instead of as
// binary. Every string is memoised because `controller.cursor` is read on every
// pointer move — rebuilding and re-encoding an SVG at that rate is real work
// for a string that changes a few times a session.

import { CURSOR_ARROW, CURSOR_BOX, CURSOR_TIP } from './cursor-paths'

/** What the click is about to do. `none` is the plain pointer. */
export type CursorBadge =
  | 'none'
  | 'add'
  | 'remove'
  | 'move'
  | 'bend'
  | 'cut'
  | 'paint'
  | 'join'

/**
 * How much the arrow's corners are rounded, in the units it was drawn in.
 *
 * Done with a round-joined stroke in the fill colour rather than by authoring
 * curves, so the shape stays editable as a plain polygon — the SVG the
 * generator reads is something you can draw in a design tool without thinking
 * about corner radii. It also grows the silhouette by this much on every side,
 * which is why the drawn shape is a little lean.
 */
const ROUNDING = 2.6
/** The dark rim, on top of the rounding, so the whole thing survives a white shape. */
const RIM = 1.6

/**
 * Badge glyphs, drawn inside a disc at the bottom right.
 *
 * The disc is about 13px across on screen, which is the whole design brief:
 * two or three strokes, nothing that has to be resolved to be understood. Each
 * of these was looked at rendered — a four-way arrow with proper heads, an arc
 * thick enough to see, and an X for the knife all read fine at 200px and turned
 * to mush or to the wrong word at 13. What survives is the crudest version of
 * each idea.
 */
const BADGES: Record<Exclude<CursorBadge, 'none'>, string> = {
  add: '<path d="M23 19.6v6.8M19.6 23h6.8" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  remove: '<path d="M19.6 23h6.8" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  // Four bars and four small heads. Thin, because the heads are what carry the
  // meaning and a fat bar swallows them.
  move: '<path d="M23 19.8v6.4M19.8 23h6.4" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>'
    + '<path d="M23 18.2l1.4 2h-2.8zM23 27.8l1.4-2h-2.8zM18.2 23l2 1.4v-2.8zM27.8 23l-2 1.4v-2.8z" fill="#fff"/>',
  // A cubic, not an arc. The `a` command packs its two flags in without
  // separators (`0 0 0 5.6-5.6`) and the first draft of this rendered as a
  // filled quarter disc rather than a hook — a curve drawn as a curve cannot
  // be misparsed into a blob.
  bend: '<path fill="none" d="M19.4 26.9C19.4 22.4 22.4 19.4 26.9 19.4" stroke="#fff" stroke-width="1.8"'
    + ' stroke-linecap="round"/>',
  // One diagonal slash, not an X: an X is what `remove` looks like, and two
  // badges that mean different things must not share a silhouette.
  cut: '<path d="M19.4 26.6l7.2-7.2" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>'
    + '<path d="M25.2 19.2l2.2-.6-.6 2.2z" fill="#fff"/>',
  paint: '<path d="M23 19c2.4 3.1 3.4 4.9 3.4 6a3.4 3.4 0 0 1-6.8 0c0-1.1 1-2.9 3.4-6z" fill="#fff"/>',
  join: '<circle cx="19.9" cy="23" r="1.9" fill="#fff"/><circle cx="26.1" cy="23" r="1.9" fill="#fff"/>'
    + '<path d="M19.9 23h6.2" stroke="#fff" stroke-width="1.2"/>',
}

/**
 * White ink over a black rim, the way system cursors are drawn — it has to
 * survive a dark canvas, a white shape and a coloured one alike. The rim is a
 * fat stroke under the fill rather than a second path, so the two can never
 * drift apart.
 */
function svg(badge: CursorBadge): string {
  const disc =
    badge === 'none'
      ? ''
      : `<circle cx="23" cy="23" r="8" fill="#000"/><circle cx="23" cy="23" r="6.4" fill="#2f7bff"/>${BADGES[badge]}`
  // Three passes over the SAME path, widest first: the rim, then the rounded
  // white body, then the body's own fill. Painting one shape three times is
  // what keeps the rim exactly parallel to the ink — two hand-offset paths
  // would drift the moment the geometry is redrawn.
  const arrow =
    `<path d="${CURSOR_ARROW}" fill="#000" stroke="#000" stroke-width="${ROUNDING + RIM * 2}"` +
    ' stroke-linejoin="round" stroke-linecap="round"/>' +
    `<path d="${CURSOR_ARROW}" fill="#fff" stroke="#fff" stroke-width="${ROUNDING}"` +
    ' stroke-linejoin="round" stroke-linecap="round"/>'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_BOX + 4}" height="${CURSOR_BOX + 4}">` +
    arrow +
    disc +
    '</svg>'
  )
}

const cache = new Map<CursorBadge, string>()

/**
 * The pointer, with an optional badge. Hotspot on the arrow's tip, which is
 * where the fill comes to a point — the rim bleeds under it, so the pixel you
 * aim with is the one that looks sharp.
 */
export function pointerCursor(badge: CursorBadge = 'none'): string {
  const hit = cache.get(badge)
  if (hit) return hit
  // The hotspot comes from the drawn shape, not from a number typed twice:
  // move the tip in the SVG and the aim follows it.
  const css =
    `url("data:image/svg+xml,${encodeURIComponent(svg(badge))}") ` +
    `${Math.round(CURSOR_TIP.x)} ${Math.round(CURSOR_TIP.y)}, default`
  cache.set(badge, css)
  return css
}

/**
 * A real rotation cursor. CSS has no keyword for one, so this is a circular
 * arrow as an inline SVG, drawn the same way. Three details are load-bearing at
 * 24px and each was a failed draft first — a translucent halo disappeared on
 * white; a head sitting on the arc merged into it, so the arc stops 25° short
 * and the head takes the tip; and round joins turned a 5px triangle into a
 * pentagon, so the head miters while the arc stays round.
 *
 * The hotspot is the centre of the ring: the arrow surrounds the point you are
 * acting on, which is what every other rotate cursor does.
 */
export const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">' +
    '<path d="M14.75 6.11A6.5 6.5 0 1 1 5.5 12" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M2.6 12.1 5.5 7.2 8.4 12.1Z" fill="#000" stroke="#000" stroke-width="2.4" stroke-linejoin="miter"/>' +
    '<path d="M14.75 6.11A6.5 6.5 0 1 1 5.5 12" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M2.6 12.1 5.5 7.2 8.4 12.1Z" fill="#fff"/>' +
    '</svg>',
)}") 12 12, alias`
