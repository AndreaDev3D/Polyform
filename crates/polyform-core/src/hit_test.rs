//! Precise hit-testing — a port of `hit-test.ts` over the Rust SceneGraph.
//! Broad phase is a linear candidate walk (same visibility/skip rules as
//! SpatialIndex.sync; an R-tree is only an accelerator, the SET is what the
//! contract specifies). BOOLEAN nodes evaluate through the exact-CSG path
//! (the same walk booleans.ts uses in WASM mode), uncached — this surface
//! backs differential tests and the future engine flip, not the hot loop.

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::booleans::{boolean_rings as csg_rings, BoolOp};
use crate::geometry::{
    aabb_contains_aabb, aabb_intersects, aabb_is_empty, apply_mat, dist_to_segment, mat_invert,
    mat_multiply, point_in_ellipse, point_in_polygon_rings, point_in_rounded_rect, vec2, Aabb,
    CornerRadius, Mat, Vec2, IDENTITY,
};
use crate::scene::SceneGraph;
use crate::shapes::{
    ellipse_path, flatten_sub_path, line_path, network_to_sub_paths, polygon_path,
    rounded_rect_path, star_path, Anchor, NetEdge, NetVertex, SubPath,
};

type Obj = Map<String, Value>;

pub struct HitOptions {
    pub tolerance_px: f64,
    pub zoom: f64,
    pub exclude: HashSet<String>,
    pub include_locked: bool,
}

fn f64_of(obj: &Obj, key: &str) -> f64 {
    obj.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

/// Absent-vs-zero matters for the arc fields: a missing arcSweep means 1
/// (a whole ellipse), not 0 (an empty one).
fn opt_f64(obj: &Obj, key: &str) -> Option<f64> {
    obj.get(key).and_then(Value::as_f64)
}

fn str_of<'a>(obj: &'a Obj, key: &str) -> &'a str {
    obj.get(key).and_then(Value::as_str).unwrap_or("")
}

fn bool_of(obj: &Obj, key: &str, default: bool) -> bool {
    obj.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn corner_radius(node: &Obj) -> CornerRadius {
    let r = node.get("cornerRadius").and_then(Value::as_object);
    CornerRadius {
        tl: r.map(|o| f64_of(o, "tl")).unwrap_or(0.0),
        tr: r.map(|o| f64_of(o, "tr")).unwrap_or(0.0),
        br: r.map(|o| f64_of(o, "br")).unwrap_or(0.0),
        bl: r.map(|o| f64_of(o, "bl")).unwrap_or(0.0),
    }
}

fn any_visible(node: &Obj, key: &str) -> bool {
    node.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_object).any(|p| bool_of(p, "visible", false)))
        .unwrap_or(false)
}

fn children_of(node: &Obj) -> Vec<String> {
    node.get("children")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default()
}

fn is_container_type(t: &str) -> bool {
    matches!(t, "FRAME" | "GROUP" | "BOOLEAN" | "COMPONENT" | "INSTANCE")
}

/// Node -> outline dispatch, mirroring shapes.ts nodeOutline.
pub fn node_outline(node: &Obj) -> Vec<SubPath> {
    let w = f64_of(node, "width");
    let h = f64_of(node, "height");
    match str_of(node, "type") {
        "RECTANGLE" | "FRAME" | "COMPONENT" | "INSTANCE" => {
            let r = corner_radius(node);
            vec![rounded_rect_path(w, h, r.tl, r.tr, r.br, r.bl)]
        }
        "ELLIPSE" => {
            // v5 arc fields; absent means a plain ellipse, and the plain
            // path must be returned verbatim so existing documents keep
            // byte-identical geometry.
            let start = opt_f64(node, "arcStart").unwrap_or(0.0);
            let sweep = opt_f64(node, "arcSweep").unwrap_or(1.0);
            let ratio = opt_f64(node, "arcRatio").unwrap_or(0.0);
            if crate::shapes::is_full_ellipse(sweep, ratio) {
                vec![ellipse_path(w, h)]
            } else {
                vec![crate::shapes::arc_path(w, h, start, sweep, ratio)]
            }
        }
        "LINE" => vec![line_path(w)],
        "POLYGON" => vec![polygon_path(w, h, f64_of(node, "pointCount"))],
        "STAR" => vec![star_path(w, h, f64_of(node, "pointCount"), f64_of(node, "innerRatio"))],
        "VECTOR" => {
            let Some(network) = node.get("network").and_then(Value::as_object) else {
                return Vec::new();
            };
            let vertices: Vec<NetVertex> = network
                .get("vertices")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_object)
                        .map(|v| NetVertex {
                            id: f64_of(v, "id"),
                            x: f64_of(v, "x"),
                            y: f64_of(v, "y"),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let cp = |v: Option<&Value>| {
                v.and_then(Value::as_object).map(|o| vec2(f64_of(o, "x"), f64_of(o, "y")))
            };
            let edges: Vec<NetEdge> = network
                .get("edges")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_object)
                        .map(|e| NetEdge {
                            v0: f64_of(e, "v0"),
                            v1: f64_of(e, "v1"),
                            cp0: cp(e.get("cp0")),
                            cp1: cp(e.get("cp1")),
                        })
                        .collect()
                })
                .unwrap_or_default();
            network_to_sub_paths(&vertices, &edges)
        }
        // TEXT / GROUP / BOOLEAN: plain w x h rectangle (zero radii)
        _ => vec![rounded_rect_path(w, h, 0.0, 0.0, 0.0, 0.0)],
    }
}

fn transform_sub_path(sp: &SubPath, m: Mat) -> SubPath {
    SubPath {
        closed: sp.closed,
        anchors: sp
            .anchors
            .iter()
            .map(|a| Anchor {
                p: apply_mat(m, a.p),
                cp_in: a.cp_in.map(|c| apply_mat(m, c)),
                cp_out: a.cp_out.map(|c| apply_mat(m, c)),
            })
            .collect(),
    }
}

/// Closed subpaths of a subtree in `space` coordinates (curves preserved) —
/// the booleans.ts WASM-path collection walk.
fn collect_sub_paths(scene: &SceneGraph, id: &str, space: Mat, out: &mut Vec<SubPath>) {
    let Some(node) = scene.get_node(id) else { return };
    let t = str_of(node, "type");
    if t == "BOOLEAN" {
        for ring in boolean_rings(scene, id) {
            if ring.len() < 3 {
                continue;
            }
            out.push(SubPath {
                closed: true,
                anchors: ring
                    .iter()
                    .map(|p| Anchor { p: apply_mat(space, *p), cp_in: None, cp_out: None })
                    .collect(),
            });
        }
        return;
    }
    if is_container_type(t) {
        for cid in children_of(node) {
            let Some(child) = scene.get_node(&cid) else { continue };
            if !bool_of(child, "visible", true) {
                continue;
            }
            let child_space = mat_multiply(space, SceneGraph::local_matrix_of(child));
            collect_sub_paths(scene, &cid, child_space, out);
        }
        return;
    }
    for sp in node_outline(node) {
        if sp.closed {
            out.push(transform_sub_path(&sp, space));
        }
    }
}

/// Boolean result rings in the boolean node's local space (exact CSG).
pub fn boolean_rings(scene: &SceneGraph, id: &str) -> Vec<Vec<Vec2>> {
    let Some(node) = scene.get_node(id) else { return Vec::new() };
    let op = match str_of(node, "booleanOp") {
        "SUBTRACT" => BoolOp::Subtract,
        "INTERSECT" => BoolOp::Intersect,
        "EXCLUDE" => BoolOp::Exclude,
        _ => BoolOp::Union,
    };
    let mut children: Vec<Vec<SubPath>> = Vec::new();
    for cid in children_of(node) {
        let Some(child) = scene.get_node(&cid) else { continue };
        if !bool_of(child, "visible", true) {
            continue;
        }
        let mut subpaths = Vec::new();
        collect_sub_paths(scene, &cid, SceneGraph::local_matrix_of(child), &mut subpaths);
        if !subpaths.is_empty() {
            children.push(subpaths);
        }
    }
    csg_rings(&children, op, 0.01, 0.25)
}

fn rings_min_dist(p: Vec2, rings: &[Vec<Vec2>], closed: bool) -> f64 {
    let mut min = f64::INFINITY;
    for ring in rings {
        let n = ring.len();
        let segs = if closed { n } else { n.saturating_sub(1) };
        for i in 0..segs {
            min = min.min(dist_to_segment(p, ring[i], ring[(i + 1) % n]));
        }
    }
    min
}

/// Exact test of a world-space point against one node.
pub fn precise_hit(scene: &SceneGraph, id: &str, world_pt: Vec2, tol_world: f64) -> bool {
    let Some(node) = scene.get_node(id) else { return false };
    let inv = mat_invert(scene.world_matrix(id));
    let p = apply_mat(inv, world_pt);
    let has_fill = any_visible(node, "fills");
    let has_stroke = any_visible(node, "strokes");
    let stroke_tol =
        tol_world + if has_stroke { f64_of(node, "strokeWeight") / 2.0 + 1.0 } else { 0.0 };
    let w = f64_of(node, "width");
    let h = f64_of(node, "height");

    match str_of(node, "type") {
        "RECTANGLE" | "FRAME" | "COMPONENT" | "INSTANCE" => {
            let inside = point_in_rounded_rect(p, w, h, corner_radius(node));
            if has_fill && inside {
                return true;
            }
            let near_x = p.x.abs().min((p.x - w).abs());
            let near_y = p.y.abs().min((p.y - h).abs());
            let within_y = p.y >= -stroke_tol && p.y <= h + stroke_tol;
            let within_x = p.x >= -stroke_tol && p.x <= w + stroke_tol;
            (near_x <= stroke_tol && within_y) || (near_y <= stroke_tol && within_x)
        }
        "ELLIPSE" => {
            let rx = w / 2.0;
            let ry = h / 2.0;
            if has_fill && point_in_ellipse(p, rx, ry, rx, ry) {
                return true;
            }
            let outer = point_in_ellipse(p, rx, ry, rx + stroke_tol, ry + stroke_tol);
            let inner = point_in_ellipse(
                p,
                rx,
                ry,
                (rx - stroke_tol).max(0.01),
                (ry - stroke_tol).max(0.01),
            );
            outer && !inner
        }
        "LINE" => dist_to_segment(p, vec2(0.0, 0.0), vec2(w, 0.0)) <= stroke_tol + 2.0,
        "TEXT" => p.x >= 0.0 && p.y >= 0.0 && p.x <= w && p.y <= h,
        "GROUP" => false, // groups are hit through their children
        "BOOLEAN" => {
            let rings = boolean_rings(scene, id);
            if rings.is_empty() {
                return false;
            }
            if has_fill && point_in_polygon_rings(p, &rings, true) {
                return true;
            }
            rings_min_dist(p, &rings, true) <= stroke_tol
        }
        // POLYGON / STAR / VECTOR
        _ => {
            let subpaths = node_outline(node);
            let closed_rings: Vec<Vec<Vec2>> = subpaths
                .iter()
                .filter(|sp| sp.closed)
                .map(|sp| flatten_sub_path(sp, 0.5))
                .collect();
            let open_rings: Vec<Vec<Vec2>> = subpaths
                .iter()
                .filter(|sp| !sp.closed)
                .map(|sp| flatten_sub_path(sp, 0.5))
                .collect();
            if has_fill && !closed_rings.is_empty() {
                let even_odd =
                    str_of(node, "type") == "VECTOR" && str_of(node, "windingRule") == "EVENODD";
                if point_in_polygon_rings(p, &closed_rings, even_odd) {
                    return true;
                }
            }
            if !closed_rings.is_empty() && rings_min_dist(p, &closed_rings, true) <= stroke_tol {
                return true;
            }
            if !open_rings.is_empty() && rings_min_dist(p, &open_rings, false) <= stroke_tol {
                return true;
            }
            false
        }
    }
}

fn eligible(scene: &SceneGraph, id: &str, opts: &HitOptions) -> bool {
    if opts.exclude.contains(id) {
        return false;
    }
    let Some(node) = scene.get_node(id) else { return false };
    if !opts.include_locked && bool_of(node, "locked", false) {
        return false;
    }
    if !opts.include_locked {
        for aid in scene.ancestors(id) {
            if scene.get_node(&aid).map(|a| bool_of(a, "locked", false)).unwrap_or(false) {
                return false;
            }
        }
    }
    true
}

pub fn is_inside_instance(scene: &SceneGraph, id: &str) -> bool {
    nearest_instance_ancestor(scene, id).is_some()
}

pub fn nearest_instance_ancestor(scene: &SceneGraph, id: &str) -> Option<String> {
    scene
        .ancestors(id)
        .into_iter()
        .find(|aid| scene.get_node(aid).map(|n| str_of(n, "type") == "INSTANCE").unwrap_or(false))
}

/// Broad-phase candidates: the SpatialIndex.sync walk (active page, visible
/// chains only, BOOLEAN children skipped, empty AABBs dropped) filtered to
/// boxes intersecting `query`.
fn broad_phase(scene: &SceneGraph, query: Aabb) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(scene: &SceneGraph, id: &str, parent_visible: bool, query: Aabb, out: &mut Vec<String>) {
        let Some(node) = scene.get_node(id) else { return };
        let visible = parent_visible && bool_of(node, "visible", true);
        if !visible {
            return;
        }
        let aabb = scene.world_aabb(id);
        if !aabb_is_empty(aabb) && aabb_intersects(aabb, query) {
            out.push(id.to_string());
        }
        let t = str_of(node, "type");
        if is_container_type(t) && t != "BOOLEAN" {
            for cid in children_of(node) {
                walk(scene, &cid, visible, query, out);
            }
        }
    }
    for id in scene.root_ids() {
        walk(scene, &id, true, query, &mut out);
    }
    out
}

fn z_rank_desc(scene: &SceneGraph, ids: &mut [String]) {
    let order = scene.render_order();
    let rank: std::collections::HashMap<&str, usize> =
        order.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
    ids.sort_by(|a, b| {
        let ra = rank.get(a.as_str()).copied().unwrap_or(0);
        let rb = rank.get(b.as_str()).copied().unwrap_or(0);
        rb.cmp(&ra)
    });
}

/// All nodes under a world point, topmost first.
pub fn hit_test_all(scene: &SceneGraph, world_pt: Vec2, opts: &HitOptions) -> Vec<String> {
    let tol_world = opts.tolerance_px / opts.zoom.max(1e-6);
    let query = Aabb {
        min_x: world_pt.x - tol_world,
        min_y: world_pt.y - tol_world,
        max_x: world_pt.x + tol_world,
        max_y: world_pt.y + tol_world,
    };
    let mut hits: Vec<String> = broad_phase(scene, query)
        .into_iter()
        .filter(|id| eligible(scene, id, opts))
        .filter(|id| precise_hit(scene, id, world_pt, tol_world))
        .collect();
    z_rank_desc(scene, &mut hits);
    hits
}

pub fn hit_test(scene: &SceneGraph, world_pt: Vec2, opts: &HitOptions) -> Option<String> {
    hit_test_all(scene, world_pt, opts).into_iter().next()
}

/// Top-level nodes intersecting the marquee rect (frames only when enclosed).
pub fn nodes_in_rect(scene: &SceneGraph, rect: Aabb, opts: &HitOptions) -> Vec<String> {
    let ids = broad_phase(scene, rect);
    let mut top_level: Vec<String> = Vec::new();
    for id in ids {
        if !eligible(scene, &id, opts) {
            continue;
        }
        let top = scene.top_level_ancestor(&id);
        if !top_level.contains(&top) {
            top_level.push(top);
        }
    }
    let mut out: Vec<String> = Vec::new();
    for id in top_level {
        let Some(node) = scene.get_node(&id) else { continue };
        let aabb = scene.world_aabb(&id);
        let t = str_of(node, "type");
        if matches!(t, "FRAME" | "COMPONENT" | "INSTANCE") {
            if aabb_contains_aabb(rect, aabb) {
                out.push(id.clone());
            } else {
                for cid in children_of(node) {
                    if scene.get_node(&cid).is_none() || !eligible(scene, &cid, opts) {
                        continue;
                    }
                    if aabb_intersects(rect, scene.world_aabb(&cid)) {
                        out.push(cid);
                    }
                }
            }
        } else if aabb_intersects(rect, aabb) {
            out.push(id.clone());
        }
    }
    out
}

/// Topmost FRAME/COMPONENT containing the point — the drop target.
pub fn find_drop_frame(
    scene: &SceneGraph,
    world_pt: Vec2,
    exclude: &HashSet<String>,
) -> Option<String> {
    let query = Aabb { min_x: world_pt.x, min_y: world_pt.y, max_x: world_pt.x, max_y: world_pt.y };
    let mut candidates: Vec<String> = broad_phase(scene, query)
        .into_iter()
        .filter(|id| {
            let Some(node) = scene.get_node(id) else { return false };
            let t = str_of(node, "type");
            if (t != "FRAME" && t != "COMPONENT") || bool_of(node, "locked", false) {
                return false;
            }
            if is_inside_instance(scene, id) {
                return false;
            }
            if exclude.contains(id) {
                return false;
            }
            if exclude.iter().any(|e| scene.is_ancestor_of(e, id) || e == id) {
                return false;
            }
            let inv = mat_invert(scene.world_matrix(id));
            let p = apply_mat(inv, world_pt);
            p.x >= 0.0 && p.y >= 0.0 && p.x <= f64_of(node, "width") && p.y <= f64_of(node, "height")
        })
        .collect();
    z_rank_desc(scene, &mut candidates);
    candidates.into_iter().next()
}

// keep IDENTITY import used even if future refactors drop other uses
const _: Mat = IDENTITY;
