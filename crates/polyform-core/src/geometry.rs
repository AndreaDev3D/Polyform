//! Pure 2D geometry — a line-for-line port of `src/renderer/src/engine/geometry.ts`.
//!
//! f64 throughout (TS numbers are IEEE 754 doubles). Plain arithmetic
//! (+ - * / sqrt, comparisons) is bit-identical to V8 by IEEE 754; the only
//! divergences possible are last-ulp differences in libm transcendentals
//! (sin/cos/hypot), which the differential suite compares with tolerance.

pub const PI: f64 = std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

pub const fn vec2(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

/// Row-major 2x3 affine matrix matching canvas setTransform(a,b,c,d,e,f).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

pub const IDENTITY: Mat = Mat { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Aabb {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

pub fn mat_multiply(m1: Mat, m2: Mat) -> Mat {
    // Applies m2 first, then m1 (i.e. result = m1 * m2).
    Mat {
        a: m1.a * m2.a + m1.c * m2.b,
        b: m1.b * m2.a + m1.d * m2.b,
        c: m1.a * m2.c + m1.c * m2.d,
        d: m1.b * m2.c + m1.d * m2.d,
        e: m1.a * m2.e + m1.c * m2.f + m1.e,
        f: m1.b * m2.e + m1.d * m2.f + m1.f,
    }
}

pub fn mat_translate(tx: f64, ty: f64) -> Mat {
    Mat { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: tx, f: ty }
}

pub fn mat_rotate_deg(deg: f64) -> Mat {
    let rad = (deg * PI) / 180.0;
    let cos = rad.cos();
    let sin = rad.sin();
    Mat { a: cos, b: sin, c: -sin, d: cos, e: 0.0, f: 0.0 }
}

pub fn mat_invert(m: Mat) -> Mat {
    let det = m.a * m.d - m.b * m.c;
    if det.abs() < 1e-12 {
        return IDENTITY;
    }
    let inv = 1.0 / det;
    Mat {
        a: m.d * inv,
        b: -m.b * inv,
        c: -m.c * inv,
        d: m.a * inv,
        e: (m.c * m.f - m.d * m.e) * inv,
        f: (m.b * m.e - m.a * m.f) * inv,
    }
}

pub fn apply_mat(m: Mat, p: Vec2) -> Vec2 {
    vec2(m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f)
}

/// Local-to-parent matrix for a node at (x, y) with size (w, h) rotated
/// `rotation` degrees about its center.
pub fn node_local_matrix(x: f64, y: f64, w: f64, h: f64, rotation: f64) -> Mat {
    if rotation == 0.0 {
        return mat_translate(x, y);
    }
    let cx = w / 2.0;
    let cy = h / 2.0;
    mat_multiply(
        mat_translate(x + cx, y + cy),
        mat_multiply(mat_rotate_deg(rotation), mat_translate(-cx, -cy)),
    )
}

// ---------------------------------------------------------------------------
// AABB
// ---------------------------------------------------------------------------

pub fn empty_aabb() -> Aabb {
    Aabb {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    }
}

pub fn aabb_is_empty(b: Aabb) -> bool {
    b.min_x > b.max_x || b.min_y > b.max_y
}

pub fn aabb_union(a: Aabb, b: Aabb) -> Aabb {
    Aabb {
        min_x: a.min_x.min(b.min_x),
        min_y: a.min_y.min(b.min_y),
        max_x: a.max_x.max(b.max_x),
        max_y: a.max_y.max(b.max_y),
    }
}

pub fn aabb_expand(b: Aabb, pad: f64) -> Aabb {
    Aabb { min_x: b.min_x - pad, min_y: b.min_y - pad, max_x: b.max_x + pad, max_y: b.max_y + pad }
}

pub fn aabb_intersects(a: Aabb, b: Aabb) -> bool {
    a.min_x <= b.max_x && a.max_x >= b.min_x && a.min_y <= b.max_y && a.max_y >= b.min_y
}

pub fn aabb_contains_point(b: Aabb, p: Vec2, pad: f64) -> bool {
    p.x >= b.min_x - pad && p.x <= b.max_x + pad && p.y >= b.min_y - pad && p.y <= b.max_y + pad
}

pub fn aabb_contains_aabb(outer: Aabb, inner: Aabb) -> bool {
    inner.min_x >= outer.min_x
        && inner.max_x <= outer.max_x
        && inner.min_y >= outer.min_y
        && inner.max_y <= outer.max_y
}

/// AABB of a w x h rect transformed by m.
pub fn transformed_rect_aabb(m: Mat, w: f64, h: f64) -> Aabb {
    let pts = [
        apply_mat(m, vec2(0.0, 0.0)),
        apply_mat(m, vec2(w, 0.0)),
        apply_mat(m, vec2(w, h)),
        apply_mat(m, vec2(0.0, h)),
    ];
    aabb_of_points(&pts)
}

pub fn aabb_of_points(pts: &[Vec2]) -> Aabb {
    let mut b = empty_aabb();
    for p in pts {
        b.min_x = b.min_x.min(p.x);
        b.min_y = b.min_y.min(p.y);
        b.max_x = b.max_x.max(p.x);
        b.max_y = b.max_y.max(p.y);
    }
    b
}

// ---------------------------------------------------------------------------
// Bezier flattening
// ---------------------------------------------------------------------------

/// Flatten a cubic bezier into a polyline (excluding the start point).
/// Adaptive-ish: fixed subdivision scaled by control polygon length.
pub fn flatten_cubic(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, tolerance: f64) -> Vec<Vec2> {
    let chord = (p1.x - p0.x).hypot(p1.y - p0.y);
    let poly = (c0.x - p0.x).hypot(c0.y - p0.y)
        + (c1.x - c0.x).hypot(c1.y - c0.y)
        + (p1.x - c1.x).hypot(p1.y - c1.y);
    let steps_f = ((poly + chord) / tolerance).sqrt().ceil();
    // JS: `for (i = 1; i <= steps; i++)` with steps = NaN runs zero times.
    if steps_f.is_nan() {
        return Vec::new();
    }
    let steps_f = steps_f.min(64.0).max(2.0);
    let steps = steps_f as u32;
    let mut out = Vec::with_capacity(steps as usize);
    for i in 1..=steps {
        let t = f64::from(i) / steps_f;
        let mt = 1.0 - t;
        let a = mt * mt * mt;
        let b = 3.0 * mt * mt * t;
        let c = 3.0 * mt * t * t;
        let d = t * t * t;
        out.push(vec2(
            a * p0.x + b * c0.x + c * c1.x + d * p1.x,
            a * p0.y + b * c0.y + c * c1.y + d * p1.y,
        ));
    }
    out
}

// ---------------------------------------------------------------------------
// Point tests
// ---------------------------------------------------------------------------

pub fn dist_to_segment(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len_sq = dx * dx + dy * dy;
    let mut t = if len_sq == 0.0 { 0.0 } else { ((p.x - a.x) * dx + (p.y - a.y) * dy) / len_sq };
    t = t.min(1.0).max(0.0);
    (p.x - (a.x + t * dx)).hypot(p.y - (a.y + t * dy))
}

/// Nonzero-winding point-in-polygon over one or more rings.
pub fn point_in_polygon_rings(p: Vec2, rings: &[Vec<Vec2>], even_odd: bool) -> bool {
    let mut winding: i64 = 0;
    let mut crossings: i64 = 0;
    for ring in rings {
        let n = ring.len();
        for i in 0..n {
            let a = ring[i];
            let b = ring[(i + 1) % n];
            if a.y <= p.y {
                if b.y > p.y && cross(a, b, p) > 0.0 {
                    winding += 1;
                    crossings += 1;
                }
            } else if b.y <= p.y && cross(a, b, p) < 0.0 {
                winding -= 1;
                crossings += 1;
            }
        }
    }
    if even_odd {
        crossings % 2 == 1
    } else {
        winding != 0
    }
}

fn cross(a: Vec2, b: Vec2, p: Vec2) -> f64 {
    (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y)
}

pub fn point_in_ellipse(p: Vec2, cx: f64, cy: f64, rx: f64, ry: f64) -> bool {
    if rx <= 0.0 || ry <= 0.0 {
        return false;
    }
    let nx = (p.x - cx) / rx;
    let ny = (p.y - cy) / ry;
    nx * nx + ny * ny <= 1.0
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CornerRadius {
    pub tl: f64,
    pub tr: f64,
    pub br: f64,
    pub bl: f64,
}

pub fn point_in_rounded_rect(p: Vec2, w: f64, h: f64, r: CornerRadius) -> bool {
    if p.x < 0.0 || p.y < 0.0 || p.x > w || p.y > h {
        return false;
    }
    let clamp = |v: f64| v.min(w.min(h) / 2.0).max(0.0);
    let tl = clamp(r.tl);
    let tr = clamp(r.tr);
    let br = clamp(r.br);
    let bl = clamp(r.bl);
    // JS truthiness `if (tl && …)`: clamped radii are >= 0, so != 0 matches.
    if tl != 0.0 && p.x < tl && p.y < tl && (p.x - tl).hypot(p.y - tl) > tl {
        return false;
    }
    if tr != 0.0 && p.x > w - tr && p.y < tr && (p.x - (w - tr)).hypot(p.y - tr) > tr {
        return false;
    }
    if br != 0.0 && p.x > w - br && p.y > h - br && (p.x - (w - br)).hypot(p.y - (h - br)) > br {
        return false;
    }
    if bl != 0.0 && p.x < bl && p.y > h - bl && (p.x - bl).hypot(p.y - (h - bl)) > bl {
        return false;
    }
    true
}

pub fn clamp(v: f64, min: f64, max: f64) -> f64 {
    v.min(max).max(min)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invert_roundtrip() {
        let m = mat_multiply(mat_translate(10.0, -4.0), mat_rotate_deg(30.0));
        let inv = mat_invert(m);
        let p = apply_mat(mat_multiply(inv, m), vec2(7.0, 3.0));
        assert!((p.x - 7.0).abs() < 1e-9 && (p.y - 3.0).abs() < 1e-9);
    }

    #[test]
    fn singular_invert_is_identity() {
        let m = Mat { a: 0.0, b: 0.0, c: 0.0, d: 0.0, e: 5.0, f: 5.0 };
        assert_eq!(mat_invert(m), IDENTITY);
    }

    #[test]
    fn flatten_cubic_step_bounds() {
        let pts = flatten_cubic(vec2(0.0, 0.0), vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(1.0, 0.0), 0.25);
        assert!(pts.len() >= 2 && pts.len() <= 64);
        let last = pts.last().unwrap();
        assert_eq!((last.x, last.y), (1.0, 0.0));
    }

    #[test]
    fn winding_vs_even_odd() {
        // Square with a same-direction inner square: nonzero fills the hole,
        // even-odd does not.
        let outer = vec![vec2(0.0, 0.0), vec2(10.0, 0.0), vec2(10.0, 10.0), vec2(0.0, 10.0)];
        let inner = vec![vec2(2.0, 2.0), vec2(8.0, 2.0), vec2(8.0, 8.0), vec2(2.0, 8.0)];
        let rings = vec![outer, inner];
        let center = vec2(5.0, 5.0);
        assert!(point_in_polygon_rings(center, &rings, false));
        assert!(!point_in_polygon_rings(center, &rings, true));
    }

    #[test]
    fn rounded_rect_corners() {
        let r = CornerRadius { tl: 5.0, tr: 0.0, br: 0.0, bl: 0.0 };
        assert!(!point_in_rounded_rect(vec2(0.5, 0.5), 20.0, 20.0, r));
        assert!(point_in_rounded_rect(vec2(5.0, 5.0), 20.0, 20.0, r));
        assert!(point_in_rounded_rect(vec2(19.5, 0.5), 20.0, 20.0, r));
    }
}
