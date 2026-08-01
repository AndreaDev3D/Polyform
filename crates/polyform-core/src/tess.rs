//! GPU geometry: fill/stroke tessellation via lyon (V0.4-Porting-Plan,
//! Sprint D). Consumes the same SubPath representation as the rest of the
//! engine and produces triangle meshes for the WebGPU backend.
//!
//! Conventions (matching the Canvas2D renderer semantics):
//! - fills: NONZERO or EVENODD winding;
//! - strokes: butt caps, miter joins, miter limit 10 (Canvas2D defaults);
//! - stroke align INSIDE/OUTSIDE is resolved on the GPU with a stencil test
//!   against the fill mesh, so this module always tessellates the CENTER
//!   stroke at the requested width (the caller doubles it for inside/out);
//! - dashes are split on the flattened path (tolerance 0.1) before stroke
//!   tessellation, mirroring canvas dashing along the arc length.

use lyon_path::math::Point;
use lyon_path::Path;
use lyon_tessellation::{
    BuffersBuilder, FillOptions, FillRule, FillTessellator, FillVertex, LineCap, LineJoin,
    StrokeOptions, StrokeTessellator, StrokeVertex, VertexBuffers,
};

use crate::geometry::{vec2, Vec2};
use crate::shapes::{flatten_sub_path, SubPath};

pub struct Mesh {
    pub positions: Vec<f32>, // interleaved x,y
    pub indices: Vec<u32>,
}

impl Mesh {
    fn from_buffers(buf: VertexBuffers<[f32; 2], u32>) -> Mesh {
        let mut positions = Vec::with_capacity(buf.vertices.len() * 2);
        for v in buf.vertices {
            positions.push(v[0]);
            positions.push(v[1]);
        }
        Mesh { positions, indices: buf.indices }
    }
}

fn pt(p: Vec2) -> Point {
    Point::new(p.x as f32, p.y as f32)
}

fn build_path(subpaths: &[SubPath], closed_only: bool) -> Path {
    let mut builder = Path::builder();
    for sp in subpaths {
        if sp.anchors.is_empty() {
            continue;
        }
        if closed_only && !sp.closed {
            continue;
        }
        let n = sp.anchors.len();
        builder.begin(pt(sp.anchors[0].p));
        let seg_count = if sp.closed { n } else { n.saturating_sub(1) };
        for i in 0..seg_count {
            let a = &sp.anchors[i];
            let b = &sp.anchors[(i + 1) % n];
            if a.cp_out.is_some() || b.cp_in.is_some() {
                let c0 = a.cp_out.unwrap_or(a.p);
                let c1 = b.cp_in.unwrap_or(b.p);
                builder.cubic_bezier_to(pt(c0), pt(c1), pt(b.p));
            } else {
                builder.line_to(pt(b.p));
            }
        }
        builder.end(sp.closed);
    }
    builder.build()
}

/// Triangulate the filled region of closed subpaths.
pub fn tessellate_fill(subpaths: &[SubPath], even_odd: bool, tolerance: f64) -> Mesh {
    let path = build_path(subpaths, true);
    let mut buffers: VertexBuffers<[f32; 2], u32> = VertexBuffers::new();
    let options = FillOptions::tolerance(tolerance as f32).with_fill_rule(if even_odd {
        FillRule::EvenOdd
    } else {
        FillRule::NonZero
    });
    let mut tess = FillTessellator::new();
    let result = tess.tessellate_path(
        &path,
        &options,
        &mut BuffersBuilder::new(&mut buffers, |v: FillVertex| v.position().to_array()),
    );
    if result.is_err() {
        return Mesh { positions: Vec::new(), indices: Vec::new() };
    }
    Mesh::from_buffers(buffers)
}

/// Triangulate a stroke (canvas defaults: butt caps, miter joins, limit 10).
pub fn tessellate_stroke(subpaths: &[SubPath], width: f64, tolerance: f64) -> Mesh {
    let path = build_path(subpaths, false);
    let mut buffers: VertexBuffers<[f32; 2], u32> = VertexBuffers::new();
    let options = StrokeOptions::tolerance(tolerance as f32)
        .with_line_width(width as f32)
        .with_line_cap(LineCap::Butt)
        .with_line_join(LineJoin::Miter)
        .with_miter_limit(10.0);
    let mut tess = StrokeTessellator::new();
    let result = tess.tessellate_path(
        &path,
        &options,
        &mut BuffersBuilder::new(&mut buffers, |v: StrokeVertex| v.position().to_array()),
    );
    if result.is_err() {
        return Mesh { positions: Vec::new(), indices: Vec::new() };
    }
    Mesh::from_buffers(buffers)
}

/// Split subpaths into open dash segments along the flattened arc length,
/// mirroring Canvas2D setLineDash. Returns polyline subpaths.
pub fn dash_sub_paths(subpaths: &[SubPath], pattern: &[f64]) -> Vec<SubPath> {
    if pattern.is_empty() || pattern.iter().all(|d| *d <= 0.0) {
        return subpaths.to_vec();
    }
    // Canvas repeats the pattern to even length.
    let pat: Vec<f64> = if pattern.len() % 2 == 1 {
        pattern.iter().chain(pattern.iter()).copied().collect()
    } else {
        pattern.to_vec()
    };
    let mut out = Vec::new();
    for sp in subpaths {
        let mut pts = flatten_sub_path(sp, 0.1);
        if sp.closed && !pts.is_empty() {
            let first = pts[0];
            pts.push(first); // close the ring for dashing purposes
        }
        if pts.len() < 2 {
            continue;
        }
        let mut pat_idx = 0usize;
        let mut pat_left = pat[0];
        let mut drawing = true;
        let mut current: Vec<Vec2> = vec![pts[0]];
        for w in pts.windows(2) {
            let (a, b) = (w[0], w[1]);
            let mut seg_len = ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt();
            let mut cursor = a;
            while seg_len > 1e-9 {
                if pat_left >= seg_len {
                    pat_left -= seg_len;
                    if drawing {
                        current.push(b);
                    }
                    seg_len = 0.0;
                } else {
                    let t = pat_left / seg_len;
                    let mid = vec2(cursor.x + (b.x - cursor.x) * t, cursor.y + (b.y - cursor.y) * t);
                    if drawing {
                        current.push(mid);
                        if current.len() >= 2 {
                            out.push(polyline(&current));
                        }
                        current = Vec::new();
                    } else {
                        current = vec![mid];
                    }
                    seg_len -= pat_left;
                    cursor = mid;
                    drawing = !drawing;
                    pat_idx = (pat_idx + 1) % pat.len();
                    pat_left = pat[pat_idx];
                }
            }
        }
        if drawing && current.len() >= 2 {
            out.push(polyline(&current));
        }
    }
    out
}

fn polyline(pts: &[Vec2]) -> SubPath {
    SubPath {
        closed: false,
        anchors: pts
            .iter()
            .map(|p| crate::shapes::Anchor { p: *p, cp_in: None, cp_out: None })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{ellipse_path, rounded_rect_path};

    fn mesh_area(mesh: &Mesh) -> f64 {
        let mut area = 0.0f64;
        for tri in mesh.indices.chunks_exact(3) {
            let p = |i: u32| {
                let idx = i as usize * 2;
                (mesh.positions[idx] as f64, mesh.positions[idx + 1] as f64)
            };
            let (ax, ay) = p(tri[0]);
            let (bx, by) = p(tri[1]);
            let (cx, cy) = p(tri[2]);
            area += ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)).abs() / 2.0;
        }
        area
    }

    #[test]
    fn rect_fill_area_is_exact() {
        let mesh = tessellate_fill(&[rounded_rect_path(100.0, 50.0, 0.0, 0.0, 0.0, 0.0)], false, 0.1);
        assert!(!mesh.indices.is_empty());
        assert!((mesh_area(&mesh) - 5000.0).abs() < 1.0);
    }

    #[test]
    fn ellipse_fill_area_close_to_analytic() {
        let mesh = tessellate_fill(&[ellipse_path(100.0, 100.0)], false, 0.05);
        let analytic = std::f64::consts::PI * 50.0 * 50.0;
        assert!(
            (mesh_area(&mesh) - analytic).abs() / analytic < 0.01,
            "area {} vs {}",
            mesh_area(&mesh),
            analytic
        );
    }

    #[test]
    fn stroke_area_tracks_perimeter_times_width() {
        let mesh = tessellate_stroke(&[rounded_rect_path(100.0, 50.0, 0.0, 0.0, 0.0, 0.0)], 4.0, 0.1);
        // perimeter 300 * width 4 = 1200 (miter corners add a little)
        let area = mesh_area(&mesh);
        assert!(area > 1150.0 && area < 1350.0, "stroke area {area}");
    }

    #[test]
    fn dashes_split_into_open_segments() {
        let dashed = dash_sub_paths(&[rounded_rect_path(100.0, 50.0, 0.0, 0.0, 0.0, 0.0)], &[10.0, 5.0]);
        assert!(dashed.len() >= 15, "got {} segments", dashed.len());
        assert!(dashed.iter().all(|sp| !sp.closed));
        // total drawn length ~ perimeter * 10/15
        let total: f64 = dashed
            .iter()
            .flat_map(|sp| sp.anchors.windows(2).map(|w| {
                ((w[1].p.x - w[0].p.x).powi(2) + (w[1].p.y - w[0].p.y).powi(2)).sqrt()
            }))
            .sum();
        assert!((total - 200.0).abs() < 15.0, "dashed length {total}");
    }
}
