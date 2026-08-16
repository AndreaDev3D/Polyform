// Reads an authored cursor SVG and hands back the outline in the space the
// renderer draws in.
//
// Two kinds of file arrive here and both have to work, because the whole point
// of keeping the pointer as an SVG is that it can be edited in a design tool:
//
//   * the hand-written one — a 30x30 viewBox, one path, no transforms;
//   * whatever Polyform's SVG exporter produces for the `cursor-arrow` frame —
//     a 1024 viewBox, every node wrapped in `<g transform="translate(…)">`, the
//     frame's own background as the first filled path, and the guide layers as
//     unfilled ones.
//
// So the reader flattens transforms, rescales to the 30-unit box, and drops the
// two things an export adds that are not the cursor. It is a separate file from
// make-cursor.mjs so the export round trip can be tested against the real
// exporter (see engine/export/cursor-roundtrip.test.ts) rather than against a
// hand-written guess at what the exporter emits.

/**
 * The side of the square a cursor is drawn in.
 *
 * Fixed, not read from the file: the badge disc, the rounding and the rim in
 * cursors.ts are all numbers in this space, so a source drawn in some other box
 * has to be rescaled into it rather than carried through. Draw at any size you
 * like — the box is normalised here.
 */
export const CURSOR_BOX = 30

// --- affine helpers -------------------------------------------------------
// SVG's own convention: [a b c d e f] means x' = ax + cy + e, y' = bx + dy + f.

const IDENTITY = [1, 0, 0, 1, 0, 0]

/** `m` applied after `n`, which is what nesting a `<g>` inside another means. */
function compose(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

function apply(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

/**
 * An SVG transform list. Leftmost is applied last, so the list composes in
 * reading order — the same order the exporter writes `translate(…) rotate(…)`.
 */
function parseTransform(attrs) {
  const list = attrs.match(/\btransform="([^"]*)"/)?.[1]
  if (!list) return IDENTITY
  let m = IDENTITY
  const re = /(matrix|translate|rotate|scale)\(([^)]*)\)/g
  for (let hit = re.exec(list); hit; hit = re.exec(list)) {
    const a = hit[2].trim().split(/[\s,]+/).map(Number)
    let step
    if (hit[1] === 'matrix') step = a.slice(0, 6)
    else if (hit[1] === 'translate') step = [1, 0, 0, 1, a[0], a[1] ?? 0]
    else if (hit[1] === 'scale') step = [a[0], 0, 0, a[1] ?? a[0], 0, 0]
    else {
      const r = (a[0] * Math.PI) / 180
      const [cos, sin] = [Math.cos(r), Math.sin(r)]
      step = [cos, sin, -sin, cos, 0, 0]
      // rotate(deg cx cy) is a rotation about a point, spelled out.
      if (a.length >= 3) {
        step = compose(compose([1, 0, 0, 1, a[1], a[2]], step), [1, 0, 0, 1, -a[1], -a[2]])
      }
    }
    m = compose(m, step)
  }
  return m
}

// --- path data ------------------------------------------------------------

/** 3dp, without the trailing zeros that make a generated file noisy. */
function f(v) {
  return String(Math.abs(v) < 1e-9 ? 0 : Number(v.toFixed(3)))
}

/**
 * Rewrite path data through an affine matrix.
 *
 * Everything becomes absolute and every implicit repeat becomes an explicit
 * command, because the output is read back by people and by this same parser.
 * `H`/`V` come out as `L`: a horizontal line stops being horizontal the moment
 * the matrix has any rotation in it, and a generator that quietly kept the
 * letter would move the point.
 */
function transformPath(d, m) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
  let i = 0
  let cmd = ''
  /** @type {{letter: string, pts: {x: number, y: number}[]}[]} */
  const out = []
  // The pen, in source units — relative commands and the implicit close both
  // need it before the matrix is applied.
  let cur = { x: 0, y: 0 }
  let start = { x: 0, y: 0 }
  const num = () => Number(tokens[i++])
  const at = (x, y, relative) => (relative ? { x: cur.x + x, y: cur.y + y } : { x, y })
  const same = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

  while (i < tokens.length) {
    const t = tokens[i]
    if (/[a-z]/i.test(t)) {
      cmd = t
      i++
    } else if (cmd === 'M') cmd = 'L'
    else if (cmd === 'm') cmd = 'l'

    const rel = cmd === cmd.toLowerCase()
    const up = cmd.toUpperCase()

    if (up === 'Z') {
      // Polyform writes a closed outline as a full lap plus `Z`, so the last
      // line lands back on the start and the close repeats it. Dropping that
      // line is what makes an export come back as the shape that was written
      // rather than the same shape with a doubled point at the tip.
      const last = out[out.length - 1]
      if (last && last.letter === 'L' && same(last.pts[0], apply(m, start.x, start.y))) out.pop()
      out.push({ letter: 'Z', pts: [] })
      cur = { ...start }
      continue
    }
    if (up === 'A') {
      throw new Error(
        'arc commands (A/a) are not supported — draw the outline with lines and cubic curves',
      )
    }

    let ends
    if (up === 'H') ends = [at(num(), rel ? 0 : cur.y, rel)]
    else if (up === 'V') ends = [at(rel ? 0 : cur.x, num(), rel)]
    else if (up === 'C') ends = [at(num(), num(), rel), at(num(), num(), rel), at(num(), num(), rel)]
    else if (up === 'S' || up === 'Q') ends = [at(num(), num(), rel), at(num(), num(), rel)]
    else ends = [at(num(), num(), rel)]

    out.push({
      letter: up === 'H' || up === 'V' ? 'L' : up,
      pts: ends.map((p) => apply(m, p.x, p.y)),
    })
    cur = ends[ends.length - 1]
    if (up === 'M') start = { ...cur }
  }

  const points = out.flatMap((c) => c.pts)
  const text = out
    .map((c) => (c.pts.length === 0 ? c.letter : `${c.letter} ${c.pts.map((p) => `${f(p.x)} ${f(p.y)}`).join(' ')}`))
    .join(' ')
  return { d: text, points, commands: out }
}

/**
 * The corner the outline starts at — the tip, and therefore the hotspot.
 *
 * On a polygon that is just the first point. On a shape whose tip has been
 * ROUNDED it is not: the path now starts where the fillet starts, off to one
 * side of the point, and taking it would aim about a pixel away from where the
 * arrow visibly points. A fillet is a corner that was cut off, though, and the
 * corner is recoverable exactly — it is where the two tangents meet.
 *
 * Falls back to the first point whenever that reconstruction is not meaningful:
 * tangents that are parallel are not a corner, and an intersection miles from
 * the path is a curve that merely happens to start there.
 */
function cornerAt(commands) {
  const first = commands[0]?.pts[0]
  if (!first) return null
  const arc = commands[1]
  if (!arc || arc.letter !== 'C') return first
  const [c0, c1, end] = arc.pts
  // Each tangent as point + direction, pointing INTO the corner from both ends.
  const r = { x: c0.x - first.x, y: c0.y - first.y }
  const s = { x: c1.x - end.x, y: c1.y - end.y }
  const denom = r.x * s.y - r.y * s.x
  if (Math.abs(denom) < 1e-9) return first
  const dx = end.x - first.x
  const dy = end.y - first.y
  const t = (dx * s.y - dy * s.x) / denom
  // Rounded to the same 3dp as the path, so the generated hotspot is a number
  // somebody can read next to the coordinates it came from.
  const corner = { x: Number((first.x + t * r.x).toFixed(3)), y: Number((first.y + t * r.y).toFixed(3)) }
  const reach = Math.hypot(corner.x - first.x, corner.y - first.y)
  return t > 0 && reach < CURSOR_BOX / 4 ? corner : first
}

// --- the document ---------------------------------------------------------

/** Every `<path>` outside `<defs>`, with the transform it sits under. */
function collectPaths(svg) {
  const found = []
  const stack = [IDENTITY]
  let skipping = 0
  const re = /<(\/?)(svg|g|path|defs|clipPath)\b([^>]*?)(\/?)>/g
  for (let hit = re.exec(svg); hit; hit = re.exec(svg)) {
    const [, closing, tag, attrs, selfClosed] = hit
    const contained = tag === 'defs' || tag === 'clipPath'
    if (contained) {
      // Clip paths and gradients are references, not artwork. A path inside one
      // is a copy of a shape that is also drawn normally, so counting it would
      // duplicate an outline.
      if (closing) skipping = Math.max(0, skipping - 1)
      else if (!selfClosed) skipping++
      continue
    }
    if (tag === 'path') {
      if (skipping > 0 || closing) continue
      const d = attrs.match(/\sd="([^"]+)"/)?.[1]
      if (d) {
        found.push({
          d,
          matrix: compose(stack[stack.length - 1], parseTransform(attrs)),
          fill: attrs.match(/\bfill="([^"]*)"/)?.[1] ?? null,
        })
      }
      continue
    }
    // svg and g
    if (closing) stack.pop()
    else if (!selfClosed) stack.push(compose(stack[stack.length - 1], parseTransform(attrs)))
  }
  return found
}

/**
 * The cursor outline, in CURSOR_BOX units, from any of the SVGs that can hold
 * one. Throws with something readable rather than returning a shape that would
 * point somewhere other than where it looks.
 *
 * Returns the path strings, the tip (which is the hotspot), and the notes on
 * what was left out — the caller prints those, because "your guide layers were
 * ignored" is only reassuring if it is said out loud.
 */
export function readCursorSvg(svg) {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1]
  if (!viewBox) throw new Error('no viewBox — the box is what the badge and the rim are measured in')
  const box = viewBox.trim().split(/\s+/).map(Number)
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
    throw new Error(`unreadable viewBox: "${viewBox}"`)
  }
  const [minX, minY, w, h] = box
  if (Math.abs(w - h) > 1e-6) {
    // Almost always one cause: an export of the arrow layer rather than the
    // frame around it, which crops the box to the shape. Say so, because "the
    // box must be square" on its own does not tell anyone what to do next.
    throw new Error(
      `the box must be square, and this one is ${w}x${h}. If it came out of Polyform, ` +
        'export the whole cursor-arrow frame: exporting one layer crops the box to that layer.',
    )
  }
  const k = CURSOR_BOX / w
  const normalise = [k, 0, 0, k, -minX * k, -minY * k]

  const raw = collectPaths(svg)
  if (raw.length === 0) throw new Error('no <path d="…"> to read')

  const notes = []
  const kept = []
  for (const p of raw) {
    // An unfilled path is a border or a guide. The cursor is a solid shape, and
    // saying so is what lets the frame carry the badge and margin guides
    // alongside the arrow without them ending up in the pointer.
    if (p.fill === 'none') {
      notes.push('an unfilled path (a guide or a border)')
      continue
    }
    const { d, points, commands } = transformPath(p.d, compose(normalise, p.matrix))
    if (points.length === 0) continue
    const xs = points.map((q) => q.x)
    const ys = points.map((q) => q.y)
    const span = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    // A shape as big as the box is the frame's own background. The arrow cannot
    // be: it has to stay clear of the edges for its rim to survive, so there is
    // a wide gap between the two rather than a line to hug.
    if (span >= CURSOR_BOX * 0.98) {
      notes.push('a full-box path (the frame background)')
      continue
    }
    kept.push({ d, points, commands })
  }
  if (kept.length === 0) {
    throw new Error(
      `nothing left after ignoring ${notes.join(' and ')} — the outline needs a fill to be read as the cursor`,
    )
  }

  const tip = cornerAt(kept[0].commands)
  // A tip in the very corner means the box is the arrow's own bounding box,
  // which happens when the arrow layer is exported instead of the frame around
  // it. The shape would survive; the hotspot and the badge placement would not.
  const edge = Math.min(tip.x, tip.y, CURSOR_BOX - tip.x, CURSOR_BOX - tip.y)
  if (edge < 0.75) {
    throw new Error(
      `the tip lands at ${f(tip.x)},${f(tip.y)} — hard against the edge of the box. ` +
        'Export the whole cursor-arrow frame, not just the arrow layer: the box is what places the badge.',
    )
  }
  return { paths: kept.map((p) => p.d), tip, notes }
}
