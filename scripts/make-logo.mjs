// Generates resources/polyform-logo.svg: a faceted P with an even-odd
// counter, a real Delaunay mesh over its interior, and 4-point sparkle
// accents. Authored in 2048 units so it drops 1:1 into a 2048 logo frame.
//
// The mesh is generated rather than drawn by hand so the mark can be retuned
// (density, jitter, facet count) without re-tracing anything — "poly" is the
// whole identity, so it should come from real triangulation.
//
// Usage: node scripts/make-logo.mjs [outDir]
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const OUT = process.argv[2] ?? path.join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'resources')

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

/** Deterministic jitter — a fixed sequence beats Math.random for a logo. */
let seed = 20260803
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

// --- point set -------------------------------------------------------------
const pts = [...OUTER.map((p) => [...p]), ...HOLE.map((p) => [...p])]
// Interior samples on a jittered grid, kept clear of the edges so triangles
// near the outline stay well-shaped.
const STEP = 172
for (let y = 380; y < 1700; y += STEP) {
  for (let x = 600; x < 1600; x += STEP) {
    const p = [x + (rnd() - 0.5) * STEP * 0.75, y + (rnd() - 0.5) * STEP * 0.75]
    if (!inLetter(p)) continue
    if (pts.some((q) => dist(p, q) < 96)) continue
    pts.push(p)
  }
}
// Extra points along the outline edges: the reference has vertices sitting on
// the silhouette, which is what makes the facets read as facets.
for (let i = 0; i < OUTER.length; i++) {
  const a = OUTER[i]
  const b = OUTER[(i + 1) % OUTER.length]
  const n = Math.floor(dist(a, b) / 260)
  for (let k = 1; k <= n; k++) {
    const t = k / (n + 1)
    pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
  }
}

// --- Delaunay (brute force: n is small, and correctness beats cleverness) --
const circum = (a, b, c) => {
  const ax = a[0], ay = a[1], bx = b[0], by = b[1], cx = c[0], cy = c[1]
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

// --- unique edges, minus anything crossing the counter ---------------------
const edges = new Map()
for (const [i, j, k] of tris) {
  for (const [a, b] of [[i, j], [j, k], [k, i]]) {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    if (edges.has(key)) continue
    const mid = [(pts[a][0] + pts[b][0]) / 2, (pts[a][1] + pts[b][1]) / 2]
    if (inPoly(mid, HOLE)) continue
    const q1 = [pts[a][0] * 0.75 + pts[b][0] * 0.25, pts[a][1] * 0.75 + pts[b][1] * 0.25]
    const q3 = [pts[a][0] * 0.25 + pts[b][0] * 0.75, pts[a][1] * 0.25 + pts[b][1] * 0.75]
    if (inPoly(q1, HOLE) || inPoly(q3, HOLE)) continue
    edges.set(key, [a, b])
  }
}

// --- sparkles: 4-point stars on a spread of mesh vertices -----------------
/** waist controls how thin the rays are: lower = sharper sparkle, and at
 *  0.16 they read as diamonds instead of stars. */
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
// Interior vertices only (index past the outline + hole), every third one,
// so the accents are spread instead of clustered.
const interior = pts.map((p, i) => [p, i]).filter(([p, i]) => i >= OUTER.length + HOLE.length && inLetter(p))
const sparkles = interior
  .filter((_, i) => i % 3 === 0)
  .slice(0, 14)
  .map(([p], i) => star(p[0], p[1], 34 + (i % 3) * 12))

// --- emit ------------------------------------------------------------------
const polyPath = (poly) => poly.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ') + ' Z'
const meshPath = [...edges.values()]
  .map(([a, b]) => `M ${Math.round(pts[a][0])} ${Math.round(pts[a][1])} L ${Math.round(pts[b][0])} ${Math.round(pts[b][1])}`)
  .join(' ')

const INK = '#23262A' // mesh + sparkle dark, a touch deeper than the backdrop
// The gradient lives in the file so the SVG is correct on its own, in a
// browser or any other tool. Polyform's importer does not read paint servers
// via url() — it warns and falls back — so the placement step sets the same
// four stops as a real gradient fill afterwards. Keep the two in sync.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 2048" width="2048" height="2048">
  <defs>
    <linearGradient id="pf-skin" x1="0.28" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#15EAD6"/>
      <stop offset="0.34" stop-color="#35C8E4"/>
      <stop offset="0.68" stop-color="#6C74E8"/>
      <stop offset="1" stop-color="#A322E0"/>
    </linearGradient>
  </defs>
  <g id="Polyform Logo">
    <path id="Backdrop" fill="#26292D" d="M 0 0 L 2048 0 L 2048 2048 L 0 2048 Z"/>
    <path id="P" fill="url(#pf-skin)" fill-rule="evenodd" d="${polyPath(OUTER)} ${polyPath(HOLE)}"/>
    <path id="Mesh" fill="none" stroke="${INK}" stroke-width="3" d="${meshPath}"/>
    <path id="Sparkles" fill="${INK}" d="${sparkles.join(' ')}"/>
    <path id="Tip Spark" fill="#2DE8DC" d="${star(554, 310, 76, 0.06)}"/>
  </g>
</svg>
`

fs.writeFileSync(`${OUT}/polyform-logo.svg`, svg)
console.log(
  `points=${pts.length} triangles=${tris.length} edges=${edges.size} sparkles=${sparkles.length} ` +
    `bytes=${svg.length}`,
)
