// Generates Polyform's mark, in two densities:
//
//   resources/polyform-logo.svg  — the full logo: dark tile, dense mesh,
//                                  sparkle accents. 2048 units, drops 1:1
//                                  into a 2048 logo frame.
//   resources/polyform-mark.svg  — the UI mark: no tile, coarse facets, no
//                                  sparkles, square viewBox. Legible at
//                                  14px, where the full mesh is mud.
//
// The mesh is generated rather than drawn by hand so the mark can be retuned
// (density, jitter, facet count) without re-tracing anything — "poly" is the
// whole identity, so it should come from real triangulation.
//
// Usage: node scripts/make-logo.mjs [outDir]
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const OUT =
  process.argv[2] ??
  path.join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'resources')

// --- the letter ------------------------------------------------------------
// Outer silhouette, clockwise from the top-left tip. Deliberately faceted:
// chamfers instead of curves, and a hair of tilt on the stem so it reads as
// drawn rather than generated.
const OUTER = [
  [554, 310], [1016, 314], [1400, 402], [1578, 682], [1590, 956],
  [1400, 1220], [1180, 1284], [910, 1300], [910, 1576], [842, 1722], [570, 1726],
]
// The counter: a pointed quad, punched with fill-rule="evenodd".
const HOLE = [[874, 644], [1198, 652], [1226, 800], [1198, 962], [874, 972]]

const SKIN = [
  { at: 0, color: '#15EAD6' },
  { at: 0.34, color: '#35C8E4' },
  { at: 0.68, color: '#6C74E8' },
  { at: 1, color: '#A322E0' },
]
const INK = '#23262A' // mesh + sparkles: a touch deeper than the backdrop
const BACKDROP = '#26292D'

// --- geometry helpers ------------------------------------------------------
const inPoly = (p, poly) => {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}
const inLetter = (p) => inPoly(p, OUTER) && !inPoly(p, HOLE)
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const polyPath = (poly) => poly.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ') + ' Z'

/** True when a point pair is a consecutive edge of the outline or the hole —
 *  i.e. the mesh edge coincides with the silhouette. Indices follow the point
 *  set's layout: OUTER first, then HOLE, then interior samples. */
const onBoundary = (a, b) => {
  const ring = (lo, n) => {
    if (a < lo || b < lo || a >= lo + n || b >= lo + n) return false
    const d = Math.abs(a - b)
    return d === 1 || d === n - 1
  }
  return ring(0, OUTER.length) || ring(OUTER.length, HOLE.length)
}

/** waist controls how thin the rays are: at 0.16 they read as diamonds. */
const star = (cx, cy, r, waist = 0.085) => {
  const w = r * waist
  const f = (v) => Math.round(v * 10) / 10
  return (
    `M ${f(cx)} ${f(cy - r)} Q ${f(cx + w)} ${f(cy - w)} ${f(cx + r)} ${f(cy)} ` +
    `Q ${f(cx + w)} ${f(cy + w)} ${f(cx)} ${f(cy + r)} ` +
    `Q ${f(cx - w)} ${f(cy + w)} ${f(cx - r)} ${f(cy)} ` +
    `Q ${f(cx - w)} ${f(cy - w)} ${f(cx)} ${f(cy - r)} Z`
  )
}

/** Triangulate the glyph's interior at a given density. */
function mesh({ step, minDist, edgeEvery, dropBoundary = false }) {
  // Deterministic jitter — a fixed sequence beats Math.random for a logo.
  let seed = 20260803
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

  const pts = [...OUTER.map((p) => [...p]), ...HOLE.map((p) => [...p])]
  // Interior samples on a jittered grid, kept clear of each other so the
  // triangles stay well-shaped.
  for (let y = 380; y < 1700; y += step) {
    for (let x = 600; x < 1600; x += step) {
      const p = [x + (rnd() - 0.5) * step * 0.75, y + (rnd() - 0.5) * step * 0.75]
      if (!inLetter(p)) continue
      if (pts.some((q) => dist(p, q) < minDist)) continue
      pts.push(p)
    }
  }
  // Extra points along the outline: vertices sitting on the silhouette are
  // what make the facets read as facets.
  for (let i = 0; i < OUTER.length; i++) {
    const a = OUTER[i]
    const b = OUTER[(i + 1) % OUTER.length]
    const n = Math.floor(dist(a, b) / edgeEvery)
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1)
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }

  // Delaunay, brute force: n is small and correctness beats cleverness.
  const circum = (a, b, c) => {
    const [ax, ay] = a
    const [bx, by] = b
    const [cx, cy] = c
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if (Math.abs(d) < 1e-9) return null
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return { c: [ux, uy], r: Math.hypot(ax - ux, ay - uy) }
  }
  const tris = []
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      for (let k = j + 1; k < pts.length; k++) {
        const cc = circum(pts[i], pts[j], pts[k])
        if (!cc) continue
        let ok = true
        for (let m = 0; m < pts.length && ok; m++) {
          if (m === i || m === j || m === k) continue
          if (dist(pts[m], cc.c) < cc.r - 1e-6) ok = false
        }
        if (!ok) continue
        const centroid = [
          (pts[i][0] + pts[j][0] + pts[k][0]) / 3,
          (pts[i][1] + pts[j][1] + pts[k][1]) / 3,
        ]
        if (!inLetter(centroid)) continue // clips the mesh to the glyph
        tris.push([i, j, k])
      }
    }
  }

  // Unique edges, minus anything crossing the counter.
  const edges = new Map()
  for (const [i, j, k] of tris) {
    for (const [a, b] of [[i, j], [j, k], [k, i]]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      if (edges.has(key)) continue
      const at = (t) => [pts[a][0] + (pts[b][0] - pts[a][0]) * t, pts[a][1] + (pts[b][1] - pts[a][1]) * t]
      if ([0.25, 0.5, 0.75].some((t) => inPoly(at(t), HOLE))) continue
      // Edges that ARE the silhouette draw nothing new — at UI sizes they
      // only thicken the outline into a smudge.
      if (dropBoundary && onBoundary(a, b)) continue
      edges.set(key, [a, b])
    }
  }
  const d = [...edges.values()]
    .map(([a, b]) => `M ${Math.round(pts[a][0])} ${Math.round(pts[a][1])} L ${Math.round(pts[b][0])} ${Math.round(pts[b][1])}`)
    .join(' ')
  const interior = pts
    .map((p, i) => [p, i])
    .filter(([p, i]) => i >= OUTER.length + HOLE.length && inLetter(p))
  return { pts, tris, edges, d, interior }
}

const gradientDef = (id) =>
  `<linearGradient id="${id}" x1="0.28" y1="0" x2="0.6" y2="1">` +
  SKIN.map((s) => `<stop offset="${s.at}" stop-color="${s.color}"/>`).join('') +
  `</linearGradient>`

// --- the full logo ---------------------------------------------------------
// The gradient lives in the file so the SVG is correct on its own, in a
// browser or any other tool. Polyform's importer does not read paint servers
// via url() — it warns and falls back — so whoever places it sets the same
// four stops as a real gradient fill afterwards. Keep the two in sync.
const full = mesh({ step: 172, minDist: 96, edgeEvery: 260 })
const sparkles = full.interior
  .filter((_, i) => i % 3 === 0)
  .slice(0, 14)
  .map(([p], i) => star(p[0], p[1], 34 + (i % 3) * 12))

const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 2048" width="2048" height="2048">
  <defs>${gradientDef('pf-skin')}</defs>
  <g id="Polyform Logo">
    <path id="Backdrop" fill="${BACKDROP}" d="M 0 0 L 2048 0 L 2048 2048 L 0 2048 Z"/>
    <path id="P" fill="url(#pf-skin)" fill-rule="evenodd" d="${polyPath(OUTER)} ${polyPath(HOLE)}"/>
    <path id="Mesh" fill="none" stroke="${INK}" stroke-width="3" d="${full.d}"/>
    <path id="Sparkles" fill="${INK}" d="${sparkles.join(' ')}"/>
    <path id="Tip Spark" fill="#2DE8DC" d="${star(554, 310, 76, 0.06)}"/>
  </g>
</svg>
`

// --- the UI mark -----------------------------------------------------------
// Square viewBox centred on the glyph, coarse facets, heavier strokes so they
// survive being drawn 14 pixels tall. No backdrop: it sits on app chrome.
const coarse = mesh({ step: 430, minDist: 320, edgeEvery: 700, dropBoundary: true })
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="310 256 1524 1524" width="1524" height="1524">
  <defs>${gradientDef('pf-mark-skin')}</defs>
  <g id="Polyform Mark">
    <path fill="url(#pf-mark-skin)" fill-rule="evenodd" d="${polyPath(OUTER)} ${polyPath(HOLE)}"/>
    <path fill="none" stroke="${INK}" stroke-width="34" stroke-opacity="0.6" d="${coarse.d}"/>
  </g>
</svg>
`

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'polyform-logo.svg'), logo)
fs.writeFileSync(path.join(OUT, 'polyform-mark.svg'), mark)

// The UI draws the mark inline (see ui/icons.tsx). Emit its path data as a
// module instead of leaving a hand-copied duplicate to drift out of sync.
const REPO = path.join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const tsPath = path.join(REPO, 'src', 'renderer', 'src', 'ui', 'mark-paths.ts')
if (fs.existsSync(path.dirname(tsPath))) {
  fs.writeFileSync(
    tsPath,
    `// GENERATED by scripts/make-logo.mjs — do not edit by hand.\n` +
      `// Re-run \`node scripts/make-logo.mjs\` after changing the logo geometry.\n\n` +
      `/** Square viewBox centred on the glyph. */\n` +
      `export const MARK_VIEWBOX = '310 256 1524 1524'\n\n` +
      `/** Outer silhouette + counter, filled with fill-rule="evenodd". */\n` +
      `export const MARK_GLYPH =\n  '${polyPath(OUTER)} ${polyPath(HOLE)}'\n\n` +
      `/** Coarse facets: enough to read as low-poly at 14px, no more. */\n` +
      `export const MARK_FACETS =\n  '${coarse.d}'\n\n` +
      `/** The skin gradient, shared with resources/polyform-*.svg. */\n` +
      `export const MARK_STOPS: { at: number; color: string }[] = ${JSON.stringify(SKIN)}\n\n` +
      `export const MARK_INK = '${INK}'\n`,
  )
  console.log(`wrote ${path.relative(REPO, tsPath)}`)
}
console.log(
  `logo: points=${full.pts.length} triangles=${full.tris.length} edges=${full.edges.size} ` +
    `sparkles=${sparkles.length} bytes=${logo.length}\n` +
    `mark: points=${coarse.pts.length} triangles=${coarse.tris.length} edges=${coarse.edges.size} ` +
    `bytes=${mark.length}`,
)
