//! Outline generation — a port of `src/renderer/src/engine/shapes.ts`.
//!
//! Node-type dispatch (`nodeOutline`) stays on the TS side; this module
//! provides the per-primitive generators, the vector-network chain walker,
//! flattening, and SVG path serialization.

use std::collections::{HashMap, HashSet};

use crate::geometry::{flatten_cubic, vec2, Vec2};

pub const KAPPA: f64 = 0.5522847498307936;

#[derive(Clone, Debug, PartialEq)]
pub struct Anchor {
    pub p: Vec2,
    /// Incoming cubic control (from previous anchor).
    pub cp_in: Option<Vec2>,
    /// Outgoing cubic control (toward next anchor); None for a straight segment.
    pub cp_out: Option<Vec2>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SubPath {
    pub closed: bool,
    pub anchors: Vec<Anchor>,
}

fn anchor(p: Vec2, cp_in: Option<Vec2>, cp_out: Option<Vec2>) -> Anchor {
    Anchor { p, cp_in, cp_out }
}

/// JS Math.round: nearest integer, ties toward +Infinity.
/// (Rust's f64::round is ties-away-from-zero — differs for negative .5s.)
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

// ---------------------------------------------------------------------------
// Primitive outlines (node-local coordinates)
// ---------------------------------------------------------------------------

pub fn rounded_rect_path(w: f64, h: f64, tl: f64, tr: f64, br: f64, bl: f64) -> SubPath {
    let max_r = w.min(h) / 2.0;
    let tl = tl.min(max_r).max(0.0);
    let tr = tr.min(max_r).max(0.0);
    let br = br.min(max_r).max(0.0);
    let bl = bl.min(max_r).max(0.0);
    if tl == 0.0 && tr == 0.0 && br == 0.0 && bl == 0.0 {
        return SubPath {
            closed: true,
            anchors: vec![
                anchor(vec2(0.0, 0.0), None, None),
                anchor(vec2(w, 0.0), None, None),
                anchor(vec2(w, h), None, None),
                anchor(vec2(0.0, h), None, None),
            ],
        };
    }
    let cp = |cond: f64, x: f64, y: f64| if cond != 0.0 { Some(vec2(x, y)) } else { None };
    let a = vec![
        // Top-left corner: arc from (0, tl) to (tl, 0)
        anchor(vec2(0.0, tl), None, cp(tl, 0.0, tl - KAPPA * tl)),
        anchor(vec2(tl, 0.0), cp(tl, tl - KAPPA * tl, 0.0), None),
        anchor(vec2(w - tr, 0.0), None, cp(tr, w - tr + KAPPA * tr, 0.0)),
        anchor(vec2(w, tr), cp(tr, w, tr - KAPPA * tr), None),
        anchor(vec2(w, h - br), None, cp(br, w, h - br + KAPPA * br)),
        anchor(vec2(w - br, h), cp(br, w - br + KAPPA * br, h), None),
        anchor(vec2(bl, h), None, cp(bl, bl - KAPPA * bl, h)),
        anchor(vec2(0.0, h - bl), cp(bl, 0.0, h - bl + KAPPA * bl), None),
    ];
    SubPath { closed: true, anchors: a }
}

pub fn ellipse_path(w: f64, h: f64) -> SubPath {
    let rx = w / 2.0;
    let ry = h / 2.0;
    let cx = rx;
    let cy = ry;
    let kx = KAPPA * rx;
    let ky = KAPPA * ry;
    SubPath {
        closed: true,
        anchors: vec![
            anchor(vec2(cx + rx, cy), Some(vec2(cx + rx, cy - ky)), Some(vec2(cx + rx, cy + ky))),
            anchor(vec2(cx, cy + ry), Some(vec2(cx + kx, cy + ry)), Some(vec2(cx - kx, cy + ry))),
            anchor(vec2(cx - rx, cy), Some(vec2(cx - rx, cy + ky)), Some(vec2(cx - rx, cy - ky))),
            anchor(vec2(cx, cy - ry), Some(vec2(cx - kx, cy - ry)), Some(vec2(cx + kx, cy - ry))),
        ],
    }
}

/// Arc / pie / ring from an ellipse — the twin of `arcPath` in shapes.ts.
/// `start`/`sweep` are turns clockwise from 12 o'clock; `ratio` is the inner
/// radius as a fraction of the outer. Must stay bit-identical to the TS
/// version: the differential fuzz suite compares them directly.
pub fn arc_path(w: f64, h: f64, start: f64, sweep: f64, ratio: f64) -> SubPath {
    let rx = w / 2.0;
    let ry = h / 2.0;
    let cx = rx;
    let cy = ry;
    let inner = ratio.clamp(0.0, 0.999);
    let turns = sweep.clamp(-1.0, 1.0);
    let total = turns * std::f64::consts::PI * 2.0;
    let from = start * std::f64::consts::PI * 2.0 - std::f64::consts::FRAC_PI_2;

    let steps = ((total.abs() / std::f64::consts::FRAC_PI_2).ceil() as i64).max(1);
    let step = total / steps as f64;
    let handle = |d: f64| (4.0 / 3.0) * (d / 4.0).tan();

    let mut anchors: Vec<Anchor> = Vec::new();
    let mut walk = |k: f64, forward: bool, anchors: &mut Vec<Anchor>| {
        for i in 0..=steps {
            let t = if forward { i } else { steps - i };
            let angle = from + step * t as f64;
            let px = cx + rx * k * angle.cos();
            let py = cy + ry * k * angle.sin();
            let hl = handle(step) * if forward { 1.0 } else { -1.0 };
            let dx = -rx * k * angle.sin() * hl;
            let dy = ry * k * angle.cos() * hl;
            let first = i == 0;
            let last = i == steps;
            anchors.push(anchor(
                vec2(px, py),
                if first { None } else { Some(vec2(px - dx, py - dy)) },
                if last { None } else { Some(vec2(px + dx, py + dy)) },
            ));
        }
    };

    walk(1.0, true, &mut anchors);
    if inner > 0.0 {
        walk(inner, false, &mut anchors);
    } else if turns.abs() < 1.0 {
        anchors.push(anchor(vec2(cx, cy), None, None));
    }
    SubPath { closed: true, anchors }
}

/// True when the arc fields still describe a plain, unbroken ellipse.
pub fn is_full_ellipse(sweep: f64, ratio: f64) -> bool {
    (sweep.abs() - 1.0).abs() < 1e-9 && ratio <= 0.0
}

pub fn line_path(w: f64) -> SubPath {
    SubPath {
        closed: false,
        anchors: vec![anchor(vec2(0.0, 0.0), None, None), anchor(vec2(w, 0.0), None, None)],
    }
}

pub fn polygon_path(w: f64, h: f64, points: f64) -> SubPath {
    // JS: Math.max(3, Math.round(points)); NaN yields an empty anchor loop.
    let n_f = js_round(points);
    let n_f = if n_f.is_nan() { f64::NAN } else { n_f.max(3.0) };
    let n = if n_f.is_finite() { n_f as u64 } else { 0 };
    let cx = w / 2.0;
    let cy = h / 2.0;
    let mut anchors = Vec::with_capacity(n as usize);
    for i in 0..n {
        let i_f = i as f64;
        let angle = -PI_OVER_2 + (i_f * 2.0 * std::f64::consts::PI) / n_f;
        anchors.push(anchor(vec2(cx + cx * angle.cos(), cy + cy * angle.sin()), None, None));
    }
    SubPath { closed: true, anchors }
}

const PI_OVER_2: f64 = std::f64::consts::PI / 2.0;

pub fn star_path(w: f64, h: f64, points: f64, inner_ratio: f64) -> SubPath {
    let n_f = js_round(points);
    let n_f = if n_f.is_nan() { f64::NAN } else { n_f.max(3.0) };
    let n = if n_f.is_finite() { n_f as u64 } else { 0 };
    let cx = w / 2.0;
    let cy = h / 2.0;
    let inner = inner_ratio.min(1.0).max(0.01);
    let mut anchors = Vec::with_capacity((n * 2) as usize);
    for i in 0..n * 2 {
        let r = if i % 2 == 0 { 1.0 } else { inner };
        let i_f = i as f64;
        let angle = -PI_OVER_2 + (i_f * std::f64::consts::PI) / n_f;
        anchors.push(anchor(
            vec2(cx + cx * r * angle.cos(), cy + cy * r * angle.sin()),
            None,
            None,
        ));
    }
    SubPath { closed: true, anchors }
}

// ---------------------------------------------------------------------------
// Vector networks -> subpaths (walks edge chains)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct NetVertex {
    pub id: f64,
    pub x: f64,
    pub y: f64,
    /// Fillet radius requested at this point; 0 is a sharp corner.
    pub corner_radius: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct NetEdge {
    pub v0: f64,
    pub v1: f64,
    pub cp0: Option<Vec2>,
    pub cp1: Option<Vec2>,
}

/// Vertex-id key with JS `Map` SameValueZero semantics for -0 (ids are
/// finite integers in practice; NaN ids are unsupported).
fn vkey(id: f64) -> u64 {
    (if id == 0.0 { 0.0f64 } else { id }).to_bits()
}

/// Replace sharp corners with circular fillets — twin of `roundSubPathCorners`
/// in shapes.ts. `radii[i]` is the request for `sp.anchors[i]`; 0 leaves it be.
///
/// Only a corner between two straight segments rounds, the trim is capped at
/// half the shorter neighbour, and the endpoints of an open path never round.
///
/// No trigonometry, on purpose: `acos`/`tan` are libm calls whose last ULP is
/// unspecified, so V8 and Rust may legitimately disagree and the parity fuzz
/// compares these outputs EXACTLY. Everything here is arithmetic and `sqrt`.
pub fn round_sub_path_corners(sp: &SubPath, radii: &[f64]) -> SubPath {
    let mut wanted = false;
    for r in radii {
        if *r > 0.0 {
            wanted = true;
            break;
        }
    }
    if !wanted {
        return sp.clone();
    }
    let n = sp.anchors.len();
    if n < 3 {
        return sp.clone();
    }

    let mut out: Vec<Anchor> = Vec::new();
    for i in 0..n {
        let a = &sp.anchors[i];
        let r = radii.get(i).copied().unwrap_or(0.0);
        let prev = &sp.anchors[if i == 0 { n - 1 } else { i - 1 }];
        let next = &sp.anchors[if i == n - 1 { 0 } else { i + 1 }];
        let is_open_end = !sp.closed && (i == 0 || i == n - 1);
        let straight_in = a.cp_in.is_none() && prev.cp_out.is_none();
        let straight_out = a.cp_out.is_none() && next.cp_in.is_none();
        if !(r > 0.0) || is_open_end || !straight_in || !straight_out {
            out.push(a.clone());
            continue;
        }

        let ux = prev.p.x - a.p.x;
        let uy = prev.p.y - a.p.y;
        let vx = next.p.x - a.p.x;
        let vy = next.p.y - a.p.y;
        let lu = (ux * ux + uy * uy).sqrt();
        let lv = (vx * vx + vy * vy).sqrt();
        if lu < 1e-9 || lv < 1e-9 {
            out.push(a.clone());
            continue;
        }
        let unx = ux / lu;
        let uny = uy / lu;
        let vnx = vx / lv;
        let vny = vy / lv;
        let c = unx * vnx + uny * vny;
        let s = (unx * vny - uny * vnx).abs();
        if s < 1e-9 || 1.0 + c < 1e-9 {
            out.push(a.clone());
            continue;
        }
        let tan_half = s / (1.0 + c);
        let t = js_min3(r / tan_half, 0.5 * lu, 0.5 * lv);
        let radius = t * tan_half;
        let t_half_turn = 1.0 / tan_half;
        let t_quarter_turn = ((1.0 + t_half_turn * t_half_turn).sqrt() - 1.0) / t_half_turn;
        let k = (4.0 / 3.0) * t_quarter_turn * radius;

        let p0 = vec2(a.p.x + unx * t, a.p.y + uny * t);
        let p3 = vec2(a.p.x + vnx * t, a.p.y + vny * t);
        out.push(anchor(p0, None, Some(vec2(p0.x - unx * k, p0.y - uny * k))));
        out.push(anchor(p3, Some(vec2(p3.x - vnx * k, p3.y - vny * k)), None));
    }
    SubPath { closed: sp.closed, anchors: out }
}

/// `Math.min(a, b, c)`: NaN-propagating, unlike Rust's `f64::min`, which
/// returns the non-NaN operand. A NaN radius must reach the same place in both
/// engines or the fuzz would find it.
fn js_min3(a: f64, b: f64, c: f64) -> f64 {
    if a.is_nan() || b.is_nan() || c.is_nan() {
        return f64::NAN;
    }
    let mut m = a;
    if b < m {
        m = b;
    }
    if c < m {
        m = c;
    }
    m
}

pub fn network_to_sub_paths(vertices: &[NetVertex], edges: &[NetEdge]) -> Vec<SubPath> {
    if edges.is_empty() {
        return Vec::new();
    }
    // Position plus the fillet request, which the rounding pass consumes.
    let mut vmap: HashMap<u64, (Vec2, f64)> = HashMap::new();
    for v in vertices {
        // Later duplicates overwrite, like JS Map.
        vmap.insert(vkey(v.id), (vec2(v.x, v.y), v.corner_radius));
    }
    // vertex key -> edge indices, in edge-array order (mirrors JS Map of arrays).
    let mut adjacency: HashMap<u64, Vec<usize>> = HashMap::new();
    for (i, e) in edges.iter().enumerate() {
        adjacency.entry(vkey(e.v0)).or_default().push(i);
        adjacency.entry(vkey(e.v1)).or_default().push(i);
    }

    let mut used: HashSet<usize> = HashSet::new();
    let mut paths: Vec<SubPath> = Vec::new();

    for i in 0..edges.len() {
        if !used.contains(&i) {
            take_chain(i, edges, &vmap, &adjacency, &mut used, &mut paths);
        }
    }
    paths
}

fn first_unused(adjacency: &HashMap<u64, Vec<usize>>, v: u64, used: &HashSet<usize>) -> Option<usize> {
    adjacency.get(&v).and_then(|list| list.iter().copied().find(|i| !used.contains(i)))
}

fn take_chain(
    start: usize,
    edges: &[NetEdge],
    vmap: &HashMap<u64, (Vec2, f64)>,
    adjacency: &HashMap<u64, Vec<usize>>,
    used: &mut HashSet<usize>,
    paths: &mut Vec<SubPath>,
) {
    // (edge index, forward?) — forward means walked v0 -> v1.
    let mut chain: Vec<(usize, bool)> = vec![(start, true)];
    used.insert(start);
    let e = edges[start];
    let e_v0 = vkey(e.v0);

    // extend forward
    let mut tail = vkey(e.v1);
    loop {
        let Some(ni) = first_unused(adjacency, tail, used) else { break };
        let ne = edges[ni];
        let forward = vkey(ne.v0) == tail;
        chain.push((ni, forward));
        used.insert(ni);
        tail = if forward { vkey(ne.v1) } else { vkey(ne.v0) };
        if tail == e_v0 {
            break; // loop closed
        }
    }
    // extend backward
    let mut head = e_v0;
    loop {
        if head == tail {
            break; // already a loop
        }
        let Some(pi) = first_unused(adjacency, head, used) else { break };
        let pe = edges[pi];
        let forward = vkey(pe.v1) == head;
        chain.insert(0, (pi, forward));
        used.insert(pi);
        head = if forward { vkey(pe.v0) } else { vkey(pe.v1) };
    }

    let closed = head == tail && chain.len() > 1;
    let mut anchors: Vec<Anchor> = Vec::new();
    // Radius requests ride alongside, one per anchor, for the rounding pass at
    // the end; SubPath has no room for them.
    let mut radii: Vec<f64> = Vec::new();
    let lookup = |vid: u64| vmap.get(&vid).copied().unwrap_or((vec2(0.0, 0.0), 0.0));
    let (head_p, head_r) = lookup(head);
    anchors.push(anchor(head_p, None, None));
    radii.push(head_r);
    let mut cursor = head;
    let last_edge_idx = chain.last().map(|c| c.0);
    for &(edge_idx, forward) in &chain {
        let edge = edges[edge_idx];
        let from = if forward { vkey(edge.v0) } else { vkey(edge.v1) };
        let to = if forward { vkey(edge.v1) } else { vkey(edge.v0) };
        if from != cursor {
            // Disconnected guard; shouldn't happen in well-formed chains.
            let (from_p, from_r) = lookup(from);
            anchors.push(anchor(from_p, None, None));
            radii.push(from_r);
        }
        let cp_a = if forward { edge.cp0 } else { edge.cp1 };
        let cp_b = if forward { edge.cp1 } else { edge.cp0 };
        anchors.last_mut().unwrap().cp_out = cp_a;
        if closed && to == head && last_edge_idx == Some(edge_idx) {
            anchors[0].cp_in = cp_b;
        } else {
            let (to_p, to_r) = lookup(to);
            anchors.push(anchor(to_p, cp_b, None));
            radii.push(to_r);
        }
        cursor = to;
    }
    paths.push(round_sub_path_corners(&SubPath { closed, anchors }, &radii));
}

// ---------------------------------------------------------------------------
// Flattening & path strings
// ---------------------------------------------------------------------------

/// Flatten a subpath to a polyline (closed rings do not repeat the first point).
pub fn flatten_sub_path(sp: &SubPath, tolerance: f64) -> Vec<Vec2> {
    let mut out: Vec<Vec2> = Vec::new();
    let n = sp.anchors.len();
    if n == 0 {
        return out;
    }
    out.push(sp.anchors[0].p);
    let seg_count = if sp.closed { n } else { n - 1 };
    for i in 0..seg_count {
        let a = &sp.anchors[i];
        let b = &sp.anchors[(i + 1) % n];
        if a.cp_out.is_some() || b.cp_in.is_some() {
            let c0 = a.cp_out.unwrap_or(a.p);
            let c1 = b.cp_in.unwrap_or(b.p);
            out.extend(flatten_cubic(a.p, c0, c1, b.p, tolerance));
        } else {
            out.push(b.p);
        }
    }
    if sp.closed && out.len() > 1 {
        out.pop(); // last point duplicates the first
    }
    out
}

/// JS `Number(v.toFixed(precision))` rendered with JS number-to-string rules.
/// Rust's `{:.p}` rounds decimal-exact ties to even where JS toFixed picks the
/// larger; that divergence needs the double's decimal expansion to terminate
/// exactly at the cutoff digit — the parity suite compares parsed values.
fn fmt_num(v: f64, precision: usize) -> String {
    if v.is_nan() {
        return "NaN".to_string();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let fixed = format!("{:.*}", precision, v);
    let x: f64 = fixed.parse().unwrap_or(0.0);
    if x == 0.0 {
        "0".to_string() // JS String(0) and String(-0) are both "0"
    } else {
        format!("{}", x) // shortest round-trip, same as JS for non-exponent range
    }
}

/// SVG path `d` string for a list of subpaths.
pub fn sub_paths_to_svg(paths: &[SubPath], precision: usize) -> String {
    let f = |v: f64| fmt_num(v, precision);
    let mut d = String::new();
    for sp in paths {
        let n = sp.anchors.len();
        if n == 0 {
            continue;
        }
        d.push_str(&format!("M {} {} ", f(sp.anchors[0].p.x), f(sp.anchors[0].p.y)));
        let seg_count = if sp.closed { n } else { n - 1 };
        for i in 0..seg_count {
            let a = &sp.anchors[i];
            let b = &sp.anchors[(i + 1) % n];
            if a.cp_out.is_some() || b.cp_in.is_some() {
                let c0 = a.cp_out.unwrap_or(a.p);
                let c1 = b.cp_in.unwrap_or(b.p);
                d.push_str(&format!(
                    "C {} {} {} {} {} {} ",
                    f(c0.x),
                    f(c0.y),
                    f(c1.x),
                    f(c1.y),
                    f(b.p.x),
                    f(b.p.y)
                ));
            } else {
                d.push_str(&format!("L {} {} ", f(b.p.x), f(b.p.y)));
            }
        }
        if sp.closed {
            d.push_str("Z ");
        }
    }
    d.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_rect_has_four_anchors() {
        let sp = rounded_rect_path(10.0, 10.0, 0.0, 0.0, 0.0, 0.0);
        assert!(sp.closed);
        assert_eq!(sp.anchors.len(), 4);
        // TS subPathsToSvg emits the redundant closing L back to the first
        // anchor before Z (segCount = n for closed paths) — parity preserved.
        assert_eq!(sub_paths_to_svg(&[sp], 3), "M 0 0 L 10 0 L 10 10 L 0 10 L 0 0 Z");
    }

    #[test]
    fn rounded_rect_clamps_radius() {
        let sp = rounded_rect_path(10.0, 10.0, 100.0, 0.0, 0.0, 0.0);
        assert_eq!(sp.anchors[0].p, vec2(0.0, 5.0));
    }

    #[test]
    fn triangle_network_closes() {
        let vertices = [
            NetVertex { id: 0.0, x: 0.0, y: 0.0, corner_radius: 0.0 },
            NetVertex { id: 1.0, x: 10.0, y: 0.0, corner_radius: 0.0 },
            NetVertex { id: 2.0, x: 5.0, y: 8.0, corner_radius: 0.0 },
        ];
        let edges = [
            NetEdge { v0: 0.0, v1: 1.0, cp0: None, cp1: None },
            NetEdge { v0: 1.0, v1: 2.0, cp0: None, cp1: None },
            NetEdge { v0: 2.0, v1: 0.0, cp0: None, cp1: None },
        ];
        let paths = network_to_sub_paths(&vertices, &edges);
        assert_eq!(paths.len(), 1);
        assert!(paths[0].closed);
        assert_eq!(paths[0].anchors.len(), 3);
    }

    #[test]
    fn open_chain_stays_open() {
        let vertices = [
            NetVertex { id: 0.0, x: 0.0, y: 0.0, corner_radius: 0.0 },
            NetVertex { id: 1.0, x: 10.0, y: 0.0, corner_radius: 0.0 },
            NetVertex { id: 2.0, x: 20.0, y: 5.0, corner_radius: 0.0 },
        ];
        let edges = [
            NetEdge { v0: 0.0, v1: 1.0, cp0: None, cp1: None },
            NetEdge { v0: 1.0, v1: 2.0, cp0: None, cp1: None },
        ];
        let paths = network_to_sub_paths(&vertices, &edges);
        assert_eq!(paths.len(), 1);
        assert!(!paths[0].closed);
        assert_eq!(paths[0].anchors.len(), 3);
    }

    #[test]
    fn flatten_closed_drops_duplicate_endpoint() {
        let sp = ellipse_path(100.0, 40.0);
        let pts = flatten_sub_path(&sp, 0.25);
        assert!(pts.len() > 8);
        let first = pts[0];
        let last = *pts.last().unwrap();
        assert!(first != last);
    }

    #[test]
    fn js_round_ties_toward_positive_infinity() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
    }
}
