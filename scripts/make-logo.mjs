// Generates Polyform's mark from one description of its geometry:
//
//   resources/polyform-logo.svg   the logo: dark rounded tile + the letter.
//                                 2048 units, matching "Polyform Logo Frame".
//   resources/polyform-mark.svg   the letter alone, square viewBox, for use
//                                 on app chrome at any size.
//   src/renderer/src/ui/mark-paths.ts   the same path data for the inline
//                                 React mark, so the app and the assets
//                                 cannot drift apart.
//
// The geometry mirrors the shapes in the document's logo frame (read back on
// 2026-08-03): a detached stem, two connector bars whose left corners are
// rounded, and the bowl circle. Edit HERE and re-run; do not hand-patch the
// generated files.
//
// The letter is emitted as ONE path with four subpaths rather than four
// separate shapes. Four shapes leave a hairline where their antialiased edges
// meet — one path is a single coverage computation, so the seam cannot exist.
// All subpaths wind clockwise so nonzero filling unions them instead of
// punching holes where they overlap.
//
// Usage: node scripts/make-logo.mjs [outDir]
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OUT = process.argv[2] ?? path.join(REPO, 'resources')

// --- geometry (frame units) -------------------------------------------------
const TILE = { x: 51.49, y: 52.49, w: 1943.02, h: 1943.03, r: 80 }
const STEM = { x: 544, y: 315.41, w: 360.59, h: 1415.68, r: { tl: 80, tr: 80, br: 80, bl: 80 } }
const BAR_TOP = { x: 927.32, y: 315, w: 266.57, h: 341.95, r: { tl: 80, tr: 0, br: 0, bl: 80 } }
const BAR_BOTTOM = { x: 922.32, y: 956.05, w: 271, h: 341.89, r: { tl: 80, tr: 0, br: 0, bl: 80 } }
/**
 * The bowl is not a disc: it is the RIGHT HALF of a ring — Polyform's arc
 * geometry (schema v5) with sweep 0.5 and inner radius 0.302. That is what
 * gives the letter its counter, and the two radial cuts at 12 and 6 o'clock
 * are the flat edges the connector bars butt against.
 */
const BOWL = { x: 694.32, y: 315.11, w: 993.16, h: 982.81, sweep: 0.5, ratio: 0.302 }

const BACKDROP = '#26292D'
const SKIN = [
  { at: 0, color: '#15EAD6' },
  { at: 0.34, color: '#35C8E4' },
  { at: 0.68, color: '#6C74E8' },
  { at: 1, color: '#A322E0' },
]
/** The gradient axis, as a fraction of the letter's own bounds. */
const LEAN_TOP = 0.28
const LEAN_BOTTOM = 0.6

// --- path emitters ---------------------------------------------------------
const n = (v) => Math.round(v * 100) / 100

/** Rounded rect, clockwise from just right of the top-left corner. */
function rectPath({ x, y, w, h, r }) {
  const max = Math.min(w, h) / 2
  const tl = Math.min(r.tl, max)
  const tr = Math.min(r.tr, max)
  const br = Math.min(r.br, max)
  const bl = Math.min(r.bl, max)
  const a = (rx, ex, ey) => (rx > 0 ? `A ${n(rx)} ${n(rx)} 0 0 1 ${n(ex)} ${n(ey)} ` : `L ${n(ex)} ${n(ey)} `)
  return (
    `M ${n(x + tl)} ${n(y)} ` +
    `L ${n(x + w - tr)} ${n(y)} ` +
    a(tr, x + w, y + tr) +
    `L ${n(x + w)} ${n(y + h - br)} ` +
    a(br, x + w - br, y + h) +
    `L ${n(x + bl)} ${n(y + h)} ` +
    a(bl, x, y + h - bl) +
    `L ${n(x)} ${n(y + tl)} ` +
    a(tl, x + tl, y) +
    'Z'
  )
}

/**
 * Half ring: down the outer edge from 12 to 6 o'clock, a radial cut inwards,
 * back up the inner edge, and a radial cut out again. One closed contour,
 * wound clockwise like the rects so nonzero filling unions them.
 */
function halfRingPath({ x, y, w, h, ratio }) {
  const rx = w / 2
  const ry = h / 2
  const cx = x + rx
  const cy = y + ry
  const ix = rx * ratio
  const iy = ry * ratio
  return (
    `M ${n(cx)} ${n(cy - ry)} ` +
    `A ${n(rx)} ${n(ry)} 0 0 1 ${n(cx)} ${n(cy + ry)} ` +
    `L ${n(cx)} ${n(cy + iy)} ` +
    `A ${n(ix)} ${n(iy)} 0 0 0 ${n(cx)} ${n(cy - iy)} Z`
  )
}

const LETTER = [rectPath(STEM), rectPath(BAR_TOP), rectPath(BAR_BOTTOM), halfRingPath(BOWL)].join(' ')

// --- the gradient ----------------------------------------------------------
// userSpaceOnUse puts the axis in the document's own coordinates, so every
// subpath samples the same line no matter where it sits. (Polyform's own
// gradients are normalised per node, which is why the shapes in the document
// each carry their own remapped start/end — same axis, expressed differently.)
const bounds = {
  minX: Math.min(STEM.x, BAR_TOP.x, BAR_BOTTOM.x, BOWL.x),
  minY: Math.min(STEM.y, BAR_TOP.y, BAR_BOTTOM.y, BOWL.y),
  maxX: Math.max(STEM.x + STEM.w, BAR_TOP.x + BAR_TOP.w, BAR_BOTTOM.x + BAR_BOTTOM.w, BOWL.x + BOWL.w),
  maxY: Math.max(STEM.y + STEM.h, BAR_TOP.y + BAR_TOP.h, BAR_BOTTOM.y + BAR_BOTTOM.h, BOWL.y + BOWL.h),
}
const bw = bounds.maxX - bounds.minX
const bh = bounds.maxY - bounds.minY
const AXIS = {
  x1: n(bounds.minX + LEAN_TOP * bw),
  y1: n(bounds.minY),
  x2: n(bounds.minX + LEAN_BOTTOM * bw),
  y2: n(bounds.maxY),
}
const gradient = (id) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" ` +
  `x1="${AXIS.x1}" y1="${AXIS.y1}" x2="${AXIS.x2}" y2="${AXIS.y2}">` +
  SKIN.map((s) => `<stop offset="${s.at}" stop-color="${s.color}"/>`).join('') +
  `</linearGradient>`

// --- emit ------------------------------------------------------------------
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 2048" width="2048" height="2048">
  <defs>${gradient('pf-skin')}</defs>
  <g id="Polyform Logo">
    <path id="Tile" fill="${BACKDROP}" d="${rectPath({ ...TILE, r: { tl: TILE.r, tr: TILE.r, br: TILE.r, bl: TILE.r } })}"/>
    <path id="P" fill="url(#pf-skin)" d="${LETTER}"/>
  </g>
</svg>
`

// Square viewBox centred on the letter: the mark sits on app chrome, so it
// carries no tile of its own.
const side = Math.max(bw, bh)
const VIEWBOX = `${n(bounds.minX + bw / 2 - side / 2)} ${n(bounds.minY + bh / 2 - side / 2)} ${n(side)} ${n(side)}`
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="${n(side)}" height="${n(side)}">
  <defs>${gradient('pf-mark-skin')}</defs>
  <path id="Polyform Mark" fill="url(#pf-mark-skin)" d="${LETTER}"/>
</svg>
`

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'polyform-logo.svg'), logo)
fs.writeFileSync(path.join(OUT, 'polyform-mark.svg'), mark)

const tsPath = path.join(REPO, 'src', 'renderer', 'src', 'ui', 'mark-paths.ts')
if (fs.existsSync(path.dirname(tsPath))) {
  fs.writeFileSync(
    tsPath,
    `// GENERATED by scripts/make-logo.mjs — do not edit by hand.\n` +
      `// Re-run \`node scripts/make-logo.mjs\` after changing the logo geometry.\n\n` +
      `/** Square viewBox centred on the letter. */\n` +
      `export const MARK_VIEWBOX = '${VIEWBOX}'\n\n` +
      `/** The whole letter as ONE path: four clockwise subpaths, nonzero fill.\n` +
      ` *  One path means one coverage computation, so no hairline where the\n` +
      ` *  stem, the bars and the bowl meet. */\n` +
      `export const MARK_GLYPH =\n  '${LETTER}'\n\n` +
      `/** Gradient axis in the same user space as MARK_GLYPH. */\n` +
      `export const MARK_AXIS = ${JSON.stringify(AXIS)}\n\n` +
      `/** The skin gradient, shared with resources/polyform-*.svg. */\n` +
      `export const MARK_STOPS: { at: number; color: string }[] = ${JSON.stringify(SKIN)}\n`,
  )
  console.log(`wrote ${path.relative(REPO, tsPath)}`)
}
console.log(
  `letter bounds ${n(bounds.minX)},${n(bounds.minY)} ${n(bw)}x${n(bh)}; ` +
    `axis ${AXIS.x1},${AXIS.y1} -> ${AXIS.x2},${AXIS.y2}\n` +
    `logo ${logo.length} bytes, mark ${mark.length} bytes, viewBox "${VIEWBOX}"`,
)
