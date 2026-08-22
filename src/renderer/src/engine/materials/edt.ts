// Signed Euclidean distance fields for the sdf shader class (bevel, neon,
// neumorphism): per pixel, how far to the shape's edge — NEGATIVE inside,
// positive outside, in pixels.
//
// Felzenszwalb & Huttenlocher's two-pass squared distance transform: exact
// (not a chamfer approximation, whose axis bias reads as facets on a bevel's
// light sweep), linear time, and — the property everything here is built on —
// a fixed arithmetic order in plain f64, so the Rust twin in
// crates/polyform-core/src/distance.rs can reproduce it BIT-IDENTICALLY.
// The differential fuzz in wasm-parity.test.ts holds the two to exact
// equality, the same contract the geometry modules live under. Change one
// without the other and that suite is what fails.

const INF = 1e20

/** One 1-D squared-distance pass (the parabola lower envelope). */
function transform1d(
  f: Float64Array,
  n: number,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}

/** 2-D squared EDT in place: columns, then rows. `grid` is width*height f64. */
function transform2d(grid: Float64Array, width: number, height: number): void {
  const n = Math.max(width, height)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x]
    transform1d(f, height, d, v, z)
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y]
  }
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) f[x] = grid[row + x]
    transform1d(f, width, d, v, z)
    for (let x = 0; x < width; x++) grid[row + x] = d[x]
  }
}

/**
 * mask: width*height coverage bytes (alpha), inside = value > 127.
 * Returns width*height f32 distances: negative inside, positive outside,
 * zero only where inside and outside pixels touch.
 */
export function signedDistanceField(mask: Uint8Array | Uint8ClampedArray, width: number, height: number): Float32Array {
  const size = width * height
  const outside = new Float64Array(size) // 0 at inside pixels -> distance TO the shape
  const inside = new Float64Array(size) // 0 at outside pixels -> distance to the outside
  for (let i = 0; i < size; i++) {
    const solid = mask[i] > 127
    outside[i] = solid ? 0 : INF
    inside[i] = solid ? INF : 0
  }
  transform2d(outside, width, height)
  transform2d(inside, width, height)
  const out = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    out[i] = Math.fround(Math.sqrt(outside[i]) - Math.sqrt(inside[i]))
  }
  return out
}
