//! Exact bezier CSG for boolean nodes (flo_curves), replacing the TS
//! polygon-flattening approximation (closes F-03, ADR-007's stated trigger).
//!
//! The scene walk stays host-side: TS collects each direct child's closed
//! subpaths with world transforms already applied to anchors AND control
//! points (affine images of beziers are beziers — exact). This module
//! self-unions each child, folds the boolean op across children on the
//! curves, and flattens only the final result to polyline rings — the same
//! output contract the TS implementation has (`booleanRings` -> Vec2[][]).

use flo_curves::bezier::path::{
    path_add, path_intersect, path_remove_interior_points, path_sub, SimpleBezierPath,
};
use flo_curves::Coord2;

use crate::geometry::{flatten_cubic, vec2, Vec2};
use crate::shapes::SubPath;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BoolOp {
    Union,
    Subtract,
    Intersect,
    Exclude,
}

impl BoolOp {
    pub fn from_u32(v: u32) -> BoolOp {
        match v {
            1 => BoolOp::Subtract,
            2 => BoolOp::Intersect,
            3 => BoolOp::Exclude,
            _ => BoolOp::Union,
        }
    }
}

fn to_bezier_paths(subpaths: &[SubPath]) -> Vec<SimpleBezierPath> {
    let mut out = Vec::new();
    for sp in subpaths {
        if !sp.closed || sp.anchors.len() < 2 {
            continue;
        }
        let n = sp.anchors.len();
        let start = Coord2(sp.anchors[0].p.x, sp.anchors[0].p.y);
        let mut segs = Vec::with_capacity(n);
        for i in 0..n {
            let a = &sp.anchors[i];
            let b = &sp.anchors[(i + 1) % n];
            let (c0, c1) = if a.cp_out.is_none() && b.cp_in.is_none() {
                // Straight segment: use the 1/3–2/3 parameterization. Control
                // points ON the endpoints give zero derivatives at t=0/1,
                // which breaks curve-intersection math inside the CSG; the
                // uniform-speed line is the same point set with sane tangents.
                (
                    vec2(a.p.x + (b.p.x - a.p.x) / 3.0, a.p.y + (b.p.y - a.p.y) / 3.0),
                    vec2(a.p.x + 2.0 * (b.p.x - a.p.x) / 3.0, a.p.y + 2.0 * (b.p.y - a.p.y) / 3.0),
                )
            } else {
                (a.cp_out.unwrap_or(a.p), b.cp_in.unwrap_or(b.p))
            };
            segs.push((Coord2(c0.x, c0.y), Coord2(c1.x, c1.y), Coord2(b.p.x, b.p.y)));
        }
        out.push((start, segs));
    }
    out
}

/// Both control points within a hair of the chord => the cubic is a line.
fn is_linear(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2) -> bool {
    let dx = p1.x - p0.x;
    let dy = p1.y - p0.y;
    let len_sq = dx * dx + dy * dy;
    if len_sq == 0.0 {
        return c0 == p0 && c1 == p0;
    }
    let eps = 1e-9 * len_sq.sqrt();
    let dev = |c: Vec2| ((c.x - p0.x) * dy - (c.y - p0.y) * dx).abs() / len_sq.sqrt();
    dev(c0) <= eps && dev(c1) <= eps
}

/// Flatten one closed bezier path to a polyline ring (no duplicate endpoint).
fn flatten_path(path: &SimpleBezierPath, tolerance: f64) -> Vec<Vec2> {
    let (start, segs) = path;
    let mut out: Vec<Vec2> = vec![vec2(start.0, start.1)];
    let mut cursor = vec2(start.0, start.1);
    for (c0, c1, end) in segs {
        let p0 = cursor;
        let c0v = vec2(c0.0, c0.1);
        let c1v = vec2(c1.0, c1.1);
        let p1 = vec2(end.0, end.1);
        // Straight segments (control points collinear with and between the
        // endpoints) get one point, matching the TS flattener's line handling.
        if is_linear(p0, c0v, c1v, p1) {
            out.push(p1);
        } else {
            out.extend(flatten_cubic(p0, c0v, c1v, p1, tolerance));
        }
        cursor = p1;
    }
    // Closed path: the final point duplicates the ring start.
    if out.len() > 1 {
        let first = out[0];
        let last = *out.last().unwrap();
        if first == last {
            out.pop();
        }
    }
    out
}

/// children: each entry is one direct child's closed subpaths (already in the
/// boolean node's local space). Returns even-odd fillable polyline rings.
pub fn boolean_rings(
    children: &[Vec<SubPath>],
    op: BoolOp,
    accuracy: f64,
    flatten_tolerance: f64,
) -> Vec<Vec<Vec2>> {
    let mut geoms: Vec<Vec<SimpleBezierPath>> = Vec::new();
    for child in children {
        let paths = to_bezier_paths(child);
        if paths.is_empty() {
            continue;
        }
        // Self-union: overlapping subpaths within one child fill solid,
        // mirroring the TS incremental-union collection.
        let unioned: Vec<SimpleBezierPath> = path_remove_interior_points(&paths, accuracy);
        if !unioned.is_empty() {
            geoms.push(unioned);
        }
    }
    let mut iter = geoms.into_iter();
    let Some(mut acc) = iter.next() else {
        return Vec::new();
    };
    for next in iter {
        // flo_curves' path ops do NOT follow empty-set algebra — e.g.
        // path_intersect(∅, b) leaks b through instead of returning ∅
        // (fuzz-found). Handle empty operands explicitly.
        acc = match op {
            BoolOp::Union => {
                if acc.is_empty() {
                    next
                } else {
                    path_add(&acc, &next, accuracy)
                }
            }
            BoolOp::Subtract => {
                if acc.is_empty() {
                    return Vec::new();
                }
                path_sub(&acc, &next, accuracy)
            }
            BoolOp::Intersect => {
                if acc.is_empty() {
                    return Vec::new();
                }
                path_intersect(&acc, &next, accuracy)
            }
            BoolOp::Exclude => {
                if acc.is_empty() {
                    next
                } else {
                    // XOR = (a ∪ b) − (a ∩ b)
                    let union: Vec<SimpleBezierPath> = path_add(&acc, &next, accuracy);
                    let inter: Vec<SimpleBezierPath> = path_intersect(&acc, &next, accuracy);
                    if inter.is_empty() {
                        union
                    } else {
                        path_sub(&union, &inter, accuracy)
                    }
                }
            }
        };
    }
    acc.iter()
        .map(|p| flatten_path(p, flatten_tolerance))
        .filter(|ring| ring.len() >= 3)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::point_in_polygon_rings;
    use crate::shapes::rounded_rect_path;

    fn shifted(sp: &SubPath, dx: f64, dy: f64) -> SubPath {
        let mut out = sp.clone();
        for a in &mut out.anchors {
            a.p = vec2(a.p.x + dx, a.p.y + dy);
            a.cp_in = a.cp_in.map(|c| vec2(c.x + dx, c.y + dy));
            a.cp_out = a.cp_out.map(|c| vec2(c.x + dx, c.y + dy));
        }
        out
    }

    fn two_rects(op: BoolOp) -> Vec<Vec<Vec2>> {
        let r1 = rounded_rect_path(100.0, 100.0, 0.0, 0.0, 0.0, 0.0);
        let r2 = shifted(&rounded_rect_path(100.0, 100.0, 0.0, 0.0, 0.0, 0.0), 50.0, 50.0);
        boolean_rings(&[vec![r1], vec![r2]], op, 0.01, 0.25)
    }

    #[test]
    fn union_covers_both() {
        let rings = two_rects(BoolOp::Union);
        assert!(!rings.is_empty());
        assert!(point_in_polygon_rings(vec2(25.0, 25.0), &rings, true));
        assert!(point_in_polygon_rings(vec2(125.0, 125.0), &rings, true));
        assert!(point_in_polygon_rings(vec2(75.0, 75.0), &rings, true));
    }

    #[test]
    fn subtract_removes_overlap() {
        let rings = two_rects(BoolOp::Subtract);
        assert!(point_in_polygon_rings(vec2(25.0, 25.0), &rings, true));
        assert!(!point_in_polygon_rings(vec2(75.0, 75.0), &rings, true));
        assert!(!point_in_polygon_rings(vec2(125.0, 125.0), &rings, true));
    }

    #[test]
    fn intersect_keeps_overlap() {
        let rings = two_rects(BoolOp::Intersect);
        assert!(point_in_polygon_rings(vec2(75.0, 75.0), &rings, true));
        assert!(!point_in_polygon_rings(vec2(25.0, 25.0), &rings, true));
    }

    #[test]
    fn exclude_removes_only_overlap() {
        let rings = two_rects(BoolOp::Exclude);
        assert!(point_in_polygon_rings(vec2(25.0, 25.0), &rings, true));
        assert!(!point_in_polygon_rings(vec2(75.0, 75.0), &rings, true));
        assert!(point_in_polygon_rings(vec2(125.0, 125.0), &rings, true));
    }

    #[test]
    fn hole_survives_even_odd() {
        // 100x100 minus a centered 20x20 -> ring + hole under even-odd
        let outer = rounded_rect_path(100.0, 100.0, 0.0, 0.0, 0.0, 0.0);
        let inner = shifted(&rounded_rect_path(20.0, 20.0, 0.0, 0.0, 0.0, 0.0), 40.0, 40.0);
        let rings = boolean_rings(&[vec![outer], vec![inner]], BoolOp::Subtract, 0.01, 0.25);
        assert_eq!(rings.len(), 2);
        assert!(point_in_polygon_rings(vec2(10.0, 10.0), &rings, true));
        assert!(!point_in_polygon_rings(vec2(50.0, 50.0), &rings, true));
    }

    #[test]
    fn curved_intersection_is_exact_not_faceted() {
        // Two circles of radius 50 overlapping; the lens area from exact CSG
        // should be close to the analytic value.
        let c1 = crate::shapes::ellipse_path(100.0, 100.0);
        let c2 = shifted(&crate::shapes::ellipse_path(100.0, 100.0), 50.0, 0.0);
        let rings = boolean_rings(&[vec![c1], vec![c2]], BoolOp::Intersect, 0.01, 0.1);
        assert!(!rings.is_empty());
        let mut area = 0.0;
        for ring in &rings {
            let n = ring.len();
            for i in 0..n {
                let a = ring[i];
                let b = ring[(i + 1) % n];
                area += a.x * b.y - b.x * a.y;
            }
        }
        area = (area / 2.0).abs();
        // analytic lens area for r=50, d=50: 2r^2*acos(d/2r) - (d/2)*sqrt(4r^2-d^2)
        let r = 50.0f64;
        let d = 50.0f64;
        let analytic = 2.0 * r * r * (d / (2.0 * r)).acos() - (d / 2.0) * (4.0 * r * r - d * d).sqrt();
        assert!(
            (area - analytic).abs() / analytic < 0.02,
            "lens area {} vs analytic {}",
            area,
            analytic
        );
    }
}

#[cfg(test)]
mod disjoint_probe {
    use super::*;
    use crate::shapes::rounded_rect_path;

    #[test]
    fn intersect_of_disjoint_rects_is_empty() {
        let r1 = rounded_rect_path(50.0, 50.0, 0.0, 0.0, 0.0, 0.0);
        let mut r2 = rounded_rect_path(50.0, 50.0, 0.0, 0.0, 0.0, 0.0);
        for a in &mut r2.anchors {
            a.p = vec2(a.p.x + 500.0, a.p.y + 500.0);
        }
        let rings = boolean_rings(&[vec![r1], vec![r2]], BoolOp::Intersect, 0.01, 0.25);
        assert!(rings.is_empty(), "expected empty intersect, got {} rings", rings.len());
    }
}

#[cfg(test)]
mod containment_probe {
    use super::*;
    use crate::geometry::point_in_polygon_rings;
    use crate::shapes::rounded_rect_path;

    fn shifted(sp: &SubPath, dx: f64, dy: f64) -> SubPath {
        let mut out = sp.clone();
        for a in &mut out.anchors {
            a.p = vec2(a.p.x + dx, a.p.y + dy);
            a.cp_in = a.cp_in.map(|c| vec2(c.x + dx, c.y + dy));
            a.cp_out = a.cp_out.map(|c| vec2(c.x + dx, c.y + dy));
        }
        out
    }

    #[test]
    fn intersect_with_contained_shape_returns_inner() {
        let outer = rounded_rect_path(200.0, 200.0, 0.0, 0.0, 0.0, 0.0);
        let inner = shifted(&rounded_rect_path(40.0, 40.0, 0.0, 0.0, 0.0, 0.0), 80.0, 80.0);
        let rings = boolean_rings(&[vec![outer], vec![inner]], BoolOp::Intersect, 0.01, 0.25);
        assert!(!rings.is_empty(), "containment intersect returned empty");
        assert!(point_in_polygon_rings(vec2(100.0, 100.0), &rings, true));
        assert!(!point_in_polygon_rings(vec2(30.0, 30.0), &rings, true));
    }

    #[test]
    fn union_with_contained_shape_is_outer() {
        let outer = rounded_rect_path(200.0, 200.0, 0.0, 0.0, 0.0, 0.0);
        let inner = shifted(&rounded_rect_path(40.0, 40.0, 0.0, 0.0, 0.0, 0.0), 80.0, 80.0);
        let rings = boolean_rings(&[vec![outer], vec![inner]], BoolOp::Union, 0.01, 0.25);
        assert_eq!(rings.len(), 1, "union of contained should be one ring, got {}", rings.len());
    }
}
